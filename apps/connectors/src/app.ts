/**
 * Hono app composition — routes, middleware, tRPC mount.
 */

import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import { logger as pinoLogger } from './logger.js';
import { registerAdapters } from './adapters/index.js';
import { registerAllVendorHandlers } from './parsers/vendor-handlers/index.js';
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
  // KAN-1140 Phase 1 PR 4 — register vendor parser handlers
  // (Formspree + Tally/Typeform/Webflow stubs) into the vendorRegistry.
  // Webhook handler at resend-inbound.ts dispatches via vendorRegistry.detect().
  registerAllVendorHandlers();

  // KAN-741 — wire Lead Inbox webhook hooks with real Prisma + Pub/Sub
  // publisher. Test seam stays available via __setInboundHooksForTest.
  setInboundHooks({
    resolveTenantBySlug: async (slug) => {
      // KAN-1140 Phase 2 — join AccountProfile for defaultLanguage +
      // supportedLanguages. Mirrors pipeline-proposer.ts:127-138 pattern
      // (1:1 by AccountProfile.tenantId @unique). Profile may be absent on
      // brand-new tenants; fall back to ["en"] / "en" so downstream
      // resolveLanguage() still honors a sane Q4(c') hierarchy.
      const t = await (getPrisma() as unknown as {
        tenant: {
          findUnique: (a: unknown) => Promise<{
            id: string;
            inboxDkimStrict: boolean;
            accountProfile: { defaultLanguage: string; supportedLanguages: string[] } | null;
          } | null>;
        };
      }).tenant.findUnique({
        where: { inboxSlug: slug },
        select: {
          id: true,
          inboxDkimStrict: true,
          accountProfile: {
            select: { defaultLanguage: true, supportedLanguages: true },
          },
        },
      });
      if (!t) return null;
      return {
        id: t.id,
        inboxDkimStrict: t.inboxDkimStrict,
        defaultLanguage: t.accountProfile?.defaultLanguage ?? 'en',
        supportedLanguages: t.accountProfile?.supportedLanguages ?? ['en'],
      };
    },
    upsertContactFromEmail: async ({ tenantId, email, firstName, lastName, companyName, source }) => {
      // Upsert: find by tenantId+email, create if absent. Match is on
      // (tenantId, email) — there's no unique index on that pair today, so
      // we do a manual find→update or create.
      //
      // KAN-954 — on Formspree-parsed leads (companyName / source passed in),
      // fill blank fields on existing Contacts without clobbering prior
      // manual edits. Form-field bag (role / monthlyLeadVolume / biggestPain
      // / etc.) is NOT written here — Contact has no `customFields` column.
      // Those fields flow through LeadReceivedEvent.metadata.customFields
      // and land on Deal.customFields in the consumer.
      const existing = await getPrisma().contact.findFirst({
        where: { tenantId, email },
        select: { id: true, firstName: true, lastName: true, companyName: true },
      });
      if (existing) {
        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        // Only Formspree-parsed leads (companyName-bearing) trigger the
        // additive identity merge; direct inbound preserves the original
        // refresh-updatedAt-only behavior.
        if (companyName !== undefined || source !== undefined) {
          if (!existing.firstName && firstName) updateData.firstName = firstName;
          if (!existing.lastName && lastName) updateData.lastName = lastName;
          if (!existing.companyName && companyName) updateData.companyName = companyName;
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
    // KAN-1140 Phase 3 PR 7 — parse-fingerprint capture: atomic UPSERT
    // on (tenant_id, structure_hash, sender_domain_hash) UNIQUE +
    // 5-LRU sample insert via CTE (single roundtrip).
    //
    // Q-ADD-3 lock: raw SQL ON CONFLICT path — Prisma's upsert can't
    // atomic-increment occurrence_count (read-modify-write race);
    // Postgres ON CONFLICT DO UPDATE preserves the increment under
    // concurrent inbounds for the same signature.
    //
    // The 4KB body cap is applied here (NOT at the call site) so the
    // hook's contract is the single source of cap truth. Webhook passes
    // uncapped body; hook truncates to 4KB.
    writeParseFingerprint: async (input) => {
      const prismaTyped = getPrisma() as unknown as {
        $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
        $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
      };
      const upsertResult = await prismaTyped.$queryRaw<Array<{ id: string }>>`
        INSERT INTO parse_fingerprints (
          id, tenant_id, structure_hash, sender_domain_hash, label_token_hash,
          format, language, vendor, format_confidence, language_confidence,
          occurrence_count, escalation_count, reclassify_count,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        VALUES (
          gen_random_uuid(), ${input.tenantId}, ${input.structureHash},
          ${input.senderDomainHash}, ${input.labelTokenHash},
          ${input.format}, ${input.language}, ${input.vendor},
          ${input.formatConfidence}, ${input.languageConfidence},
          1, 0, 0, NOW(), NOW(), NOW(), NOW()
        )
        ON CONFLICT (tenant_id, structure_hash, sender_domain_hash)
        DO UPDATE SET
          occurrence_count = parse_fingerprints.occurrence_count + 1,
          last_seen_at = NOW(),
          language = COALESCE(EXCLUDED.language, parse_fingerprints.language),
          vendor = COALESCE(EXCLUDED.vendor, parse_fingerprints.vendor),
          label_token_hash = COALESCE(EXCLUDED.label_token_hash, parse_fingerprints.label_token_hash),
          updated_at = NOW()
        RETURNING id
      `;
      const fingerprintId = upsertResult[0]?.id;
      if (!fingerprintId) return; // defensive — RETURNING always yields a row

      // 4KB cap per Q8 storage budget.
      const bodyCapped = input.bodyForSample.slice(0, 4096);
      const customFieldsJson = JSON.stringify(input.customFields ?? {});
      // Insert the new sample, then prune to 5 LRU by captured_at DESC.
      // Two-statement form because Postgres CTEs that mix DML on the
      // same table can hit "tuple to be locked was already modified"
      // races; serial statements are cleaner.
      await prismaTyped.$executeRaw`
        INSERT INTO parse_fingerprint_samples (
          id, fingerprint_id, resend_email_id, body_preview,
          sender_domain, custom_fields, captured_at
        )
        VALUES (
          gen_random_uuid(), ${fingerprintId}, ${input.resendEmailId},
          ${bodyCapped}, ${input.senderDomain}, ${customFieldsJson}::jsonb, NOW()
        )
      `;
      await prismaTyped.$executeRaw`
        DELETE FROM parse_fingerprint_samples
        WHERE fingerprint_id = ${fingerprintId}
          AND id NOT IN (
            SELECT id FROM parse_fingerprint_samples
            WHERE fingerprint_id = ${fingerprintId}
            ORDER BY captured_at DESC
            LIMIT 5
          )
      `;
    },
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
