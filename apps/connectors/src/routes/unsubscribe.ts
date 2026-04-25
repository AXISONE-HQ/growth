/**
 * Unsubscribe GET handler — KAN-661.
 *
 * Mounted at GET /unsubscribe/:contactId. Composed into the email body by
 * KAN-660's message composer. Clicking writes an EmailSuppression row and
 * returns a plain HTML confirmation page.
 *
 * Public endpoint (no auth) — the URL itself is the capability. KAN-661
 * ships an unsigned stub; KAN-674 / follow-ups will rotate to signed JWTs.
 */
import { Hono } from 'hono';
import { prisma } from '../repository/connection-repository.js';
import { suppressDb } from '../adapters/resend/suppressions.js';
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
