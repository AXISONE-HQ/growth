/**
 * Hono app composition — routes, middleware, tRPC mount.
 */

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { logger as pinoLogger } from './logger.js';
import { registerAdapters } from './adapters/index.js';
import { webhooksApp } from './webhooks/index.js';
import { resendWebhookApp } from './webhooks/resend.js';
import {
  resendInboundWebhookApp,
  setInboundHooks,
  defaultPublishLeadReceived,
} from './webhooks/resend-inbound.js';
import { PrismaClient } from '@prisma/client';
import { actionSendPushApp } from './subscribers/action-send-push.js';
import { unsubscribeApp } from './routes/unsubscribe.js';
import { buildOidcMiddleware } from './middleware/oidc.js';
import { connectorsRouter } from './trpc/index.js';
import { createContext } from './trpc/context.js';

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) _prisma = new PrismaClient();
  return _prisma;
}

export function buildApp(): Hono {
  registerAdapters();

  // KAN-741 — wire Lead Inbox webhook hooks with real Prisma + Pub/Sub
  // publisher. Test seam stays available via __setInboundHooksForTest.
  setInboundHooks({
    resolveTenantBySlug: async (slug) => {
      const t = await (getPrisma() as unknown as { tenant: { findUnique: (a: unknown) => Promise<{ id: string; inboxDkimStrict: boolean } | null> } }).tenant.findUnique({
        where: { inboxSlug: slug },
        select: { id: true, inboxDkimStrict: true },
      });
      return t;
    },
    upsertContactFromEmail: async ({ tenantId, email, firstName, lastName, companyName, customFields, source }) => {
      // Upsert: find by tenantId+email, create if absent. Match is on
      // (tenantId, email) — there's no unique index on that pair today, so
      // we do a manual find→update or create.
      //
      // KAN-954 — on Formspree-parsed leads (customFields present), we now
      // ALSO update existing Contacts with the new firstName/lastName/
      // companyName/customFields when they were previously blank. The
      // legacy path (existing Contact, no customFields) preserves the
      // original "refresh updatedAt only" behavior so direct inbound
      // doesn't clobber prior identity edits.
      const existing = await getPrisma().contact.findFirst({
        where: { tenantId, email },
        select: { id: true, firstName: true, lastName: true, companyName: true, customFields: true },
      });
      if (existing) {
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (customFields !== undefined) {
          if (!existing.firstName && firstName) updateData.firstName = firstName;
          if (!existing.lastName && lastName) updateData.lastName = lastName;
          if (!existing.companyName && companyName) updateData.companyName = companyName;
          // Merge customFields (Formspree fields are additive — never overwrite
          // prior entries the user may have set manually).
          const prior = (existing.customFields ?? {}) as Record<string, unknown>;
          updateData.customFields = { ...customFields, ...prior };
        }
        await getPrisma().contact.update({
          where: { id: existing.id },
          data: updateData,
        });
        return { id: existing.id };
      }
      const created = await getPrisma().contact.create({
        data: {
          tenantId,
          email,
          firstName,
          lastName,
          companyName: companyName ?? null,
          customFields: customFields ?? {},
          source: source ?? 'email_inbox',
          lifecycleStage: 'lead',
        },
      });
      return { id: created.id };
    },
    writeLeadInboxEvent: async (row) => {
      await (getPrisma() as unknown as { leadInboxEvent: { create: (a: unknown) => Promise<unknown> } }).leadInboxEvent.create({
        data: {
          tenantId: row.tenantId,
          inboxAddress: row.inboxAddress,
          resendEmailId: row.resendEmailId,
          fromAddress: row.fromAddress,
          subject: row.subject,
          bodyPreview: row.bodyPreview,
          attachmentCount: row.attachmentCount,
          spfPass: row.spfPass,
          dkimPass: row.dkimPass,
          status: row.status,
          rejectionReason: row.rejectionReason,
          createdContactId: row.createdContactId,
        },
      });
    },
    publishLeadReceived: defaultPublishLeadReceived,
  });

  const app = new Hono();

  // Request logging middleware
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    pinoLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });

  // Health endpoints (Cloud Run probes)
  app.get('/healthz', (c) => c.json({ status: 'ok', service: '@growth-ai/connectors' }));
  app.get('/readyz', (c) => c.json({ ready: true }));

  // KAN-684 — Resend-specific webhook handler. Mounted BEFORE the generic
  // /webhooks/:provider dispatcher so the more-specific path wins routing
  // (Hono honors registration order). Svix-signed; public; no OIDC.
  app.route('/webhooks/resend', resendWebhookApp);

  // KAN-741 — Resend Inbound webhook handler. Separate route from outbound
  // /webhooks/resend so the dispatch is unambiguous (different svix secret,
  // different downstream — outbound publishes action.executed, inbound
  // publishes lead.received).
  app.route('/webhooks/resend-inbound', resendInboundWebhookApp);

  // Public webhook ingress (generic dispatcher for Twilio / Meta — Resend
  // is handled above by its own dedicated handler).
  app.route('/webhooks', webhooksApp);

  // Public unsubscribe landing (no auth — capability URL) — KAN-661
  app.route('/unsubscribe', unsubscribeApp);

  // Pub/Sub push subscriptions — OIDC verified at app-layer middleware (KAN-688).
  // Companion to PR #29's RFC 8058 work: the service is `--allow-unauthenticated`
  // so RFC 8058 one-click POSTs from Microsoft / Gmail filters reach `/unsubscribe`,
  // which means anything sensitive (Pub/Sub push, etc.) needs its own auth check.
  app.use('/pubsub/*', buildOidcMiddleware());
  app.route('/pubsub', actionSendPushApp);

  // Private VPC tRPC endpoint for Connection Manager
  app.use(
    '/trpc/*',
    trpcServer({
      router: connectorsRouter,
      createContext: (_opts, c) => createContext({ req: c.req.raw }),
    }),
  );

  // Catch-all 404
  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  app.onError((err, c) => {
    pinoLogger.error({ err }, 'unhandled error');
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}
