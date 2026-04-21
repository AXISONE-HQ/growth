/**
 * action.send subscriber — Cloud Run Pub/Sub push endpoint.
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/action-send
 *   ↓
 *   Verify OIDC token (handled by Cloud Run)
 *   ↓
 *   Decode + Zod-validate payload
 *   ↓
 *   Idempotency check (actionId already processed?)
 *   ↓
 *   Load ChannelConnection by connectionId
 *   ↓
 *   Rate-limit check (tenant × channel × provider)
 *   ↓
 *   adapter.send(connection, message)
 *   ↓
 *   Publish action.executed
 *   ↓
 *   Return 200 (ack) or 500 (nack → Pub/Sub retries)
 *
 * KAN-485: action.send push subscription handler
 */

import { Hono } from 'hono';
import { ActionSendEventSchema } from '@growth/connector-contracts';
import { logger } from '../logger.js';

export const pubsubApp = new Hono();

pubsubApp.post('/action-send', async (c) => {
  const body = await c.req.json();

  // Pub/Sub push wraps the payload: { message: { data: base64, ... }, subscription }
  const data = body?.message?.data;
  if (!data) return c.text('Bad Request', 400);

  let event;
  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    event = ActionSendEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    logger.error({ err }, 'malformed action.send event');
    // Return 200 so Pub/Sub doesn't retry unparseable messages forever
    return c.text('OK', 200);
  }

  logger.info(
    { actionId: event.message.actionId, connectionId: event.connectionId },
    'action.send received (stub)',
  );

  // TODO(KAN-485, KAN-545): full send flow — load connection, rate-limit, dispatch, publish result
  return c.text('OK', 200);
});
