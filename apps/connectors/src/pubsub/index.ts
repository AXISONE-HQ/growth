/**
 * Pub/Sub publisher wrapper — validates every event against its Zod
 * schema before publishing. Fail-fast on schema drift.
 *
 * KAN-528: Pub/Sub publisher/subscriber wrapper package
 */

import { PubSub } from '@google-cloud/pubsub';
import type { PubSubEvent } from '@growth/connector-contracts';
import { PubSubEventSchema } from '@growth/connector-contracts';
import { env } from '../env.js';
import { logger } from '../logger.js';

const pubsub = new PubSub({
  projectId: env.GCP_PROJECT_ID,
  ...(env.PUBSUB_EMULATOR_HOST ? { apiEndpoint: env.PUBSUB_EMULATOR_HOST } : {}),
});

export async function publishEvent(event: PubSubEvent): Promise<string> {
  const parsed = PubSubEventSchema.parse(event); // validates shape + discriminates by topic
  const buffer = Buffer.from(JSON.stringify(parsed));

  try {
    const messageId = await pubsub.topic(parsed.topic).publishMessage({ data: buffer });
    logger.debug({ topic: parsed.topic, messageId }, 'pub/sub event published');
    return messageId;
  } catch (err) {
    logger.error({ err, topic: parsed.topic }, 'pub/sub publish failed');
    throw err;
  }
}
