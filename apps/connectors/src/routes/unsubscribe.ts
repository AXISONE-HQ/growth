/**
 * Unsubscribe handlers.
 *
 * GET /unsubscribe/:contactId — KAN-661. In-email click landing. Capability URL,
 *   no auth, writes an EmailSuppression row, returns an HTML confirmation page.
 *
 * POST /unsubscribe?token=... — KAN-687 / RFC 8058. One-click receiver-driven
 *   unsubscribe (Microsoft, Gmail, Yahoo). Validates the HMAC-SHA256 signed
 *   token, suppresses, returns 200 OK with no body. Replaces nothing — sits
 *   alongside the GET handler for the click flow.
 *
 * Both paths terminate at the same suppression write (`suppressDb`) so policy
 * is consistent regardless of which path the receiver takes.
 */
import { Hono } from 'hono';
import { prisma } from '../repository/connection-repository.js';
import { suppressDb } from '../adapters/resend/suppressions.js';
import { verifyUnsubscribeToken } from '../adapters/resend/unsubscribe-token.js';
import { logger } from '../logger.js';

export const unsubscribeApp = new Hono();

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 24px; color: #111; line-height: 1.6; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  p { color: #555; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${body}</p>
</body>
</html>`;
}

unsubscribeApp.get('/:contactId', async (c) => {
  const contactId = c.req.param('contactId');

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, tenantId: true, email: true },
  });

  if (!contact?.email) {
    logger.warn({ contactId }, '[unsubscribe] contact not found or missing email');
    return c.html(
      page(
        'Unsubscribe link expired',
        'We couldn&rsquo;t find your record. If you keep receiving emails, reply with "unsubscribe" and we&rsquo;ll take you off the list.',
      ),
      404,
    );
  }

  try {
    await suppressDb(contact.tenantId, contact.email, 'unsubscribed');
  } catch (err) {
    logger.error({ err, contactId, tenantId: contact.tenantId }, '[unsubscribe] suppression write failed');
    return c.html(
      page(
        'Something went wrong',
        'We couldn&rsquo;t process your unsubscribe just now. Please try again in a moment.',
      ),
      500,
    );
  }

  return c.html(
    page(
      'You&rsquo;ve been unsubscribed',
      `${contact.email} has been removed from all future emails from this sender.`,
    ),
    200,
  );
});

// ── POST /unsubscribe?token=... — RFC 8058 one-click ─────────────
// Microsoft and Gmail POST to this URL when a recipient hits the inbox-level
// "Unsubscribe" affordance. RFC 8058 requires a 200 OK response. We never
// 4xx on a malformed token (would just trigger a retry storm and make us look
// flaky to the receiver) — log and respond 200 either way.
unsubscribeApp.post('/', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    logger.warn('[unsubscribe POST] no token in query string');
    return c.text('OK', 200);
  }

  const payload = await verifyUnsubscribeToken(token);
  if (!payload) {
    logger.warn('[unsubscribe POST] token invalid or expired');
    return c.text('OK', 200);
  }

  try {
    await suppressDb(payload.tenantId, payload.email, 'unsubscribed');
    logger.info(
      { tenantId: payload.tenantId, email: payload.email, actionId: payload.actionId },
      '[unsubscribe POST] suppressed via one-click',
    );
  } catch (err) {
    logger.error(
      { err, tenantId: payload.tenantId, email: payload.email },
      '[unsubscribe POST] suppression write failed',
    );
    // Still 200 per RFC 8058; we'll catch the gap via DB monitoring, not retry.
  }

  return c.text('OK', 200);
});
