/**
 * KAN-707 PR B — Knowledge ingestion worker (Cloud Run job binary).
 * KAN-734 — Boot-wires costPublisher so the default embedFn emits llm.call.
 *
 * Invoked by the apps/api push subscriber via Cloud Run Jobs API. Reads the
 * INGESTION_ID from env, queries the KnowledgeIngestion + KnowledgeSource
 * rows, runs the right path handler, embeds chunks, writes to KnowledgeChunk,
 * publishes knowledge.ingest.completed (or .failed).
 *
 * Idempotency (job-side guard, belt-and-suspenders with the subscriber-side
 * Cloud Run execution-name dedup):
 *   - On entry, check KnowledgeIngestion.status. If already `processing` or
 *     `indexed`, no-op + log + exit 0. (Subscriber-side dedup catches most
 *     duplicate dispatches; this catches the ones that slip through.)
 *
 * Status transitions:
 *   pending → processing (on entry)
 *   processing → indexed (on success)
 *   processing → failed (on unrecoverable error)
 *
 * Exit codes:
 *   0 — success or no-op (idempotency hit)
 *   1 — unrecoverable error (Cloud Run job marks task FAILED; PubSub redelivers)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Storage } from "@google-cloud/storage";
import { PubSub } from "@google-cloud/pubsub";
import type { PubSubClient } from "@growth/llm-cost-tracking";
import { runHandler } from "./handlers/run-handler.js";

const prisma = new PrismaClient();
const storage = new Storage();

/**
 * KAN-734: thin adapter so PubSub.topic(...).publishMessage satisfies the
 * structural PubSubClient interface in @growth/llm-cost-tracking. Lazy-
 * created so a missing GCP credential doesn't crash workers running locally
 * with no cost-emit need (boot still succeeds; cost emit is best-effort).
 */
function makeCostPublisher(): PubSubClient | undefined {
  try {
    const pubsub = new PubSub();
    return {
      async publish(topic: string, data: Buffer, attributes?: Record<string, string>): Promise<string> {
        const msg = await pubsub.topic(topic).publishMessage({ data, attributes });
        return msg;
      },
    };
  } catch (err) {
    console.warn("[worker] cost publisher unavailable — embedding cost events will be skipped", err);
    return undefined;
  }
}

async function main(): Promise<number> {
  const ingestionId = process.env.INGESTION_ID;
  if (!ingestionId) {
    console.error("[worker] INGESTION_ID env var required");
    return 1;
  }
  console.log(`[worker] start ingestionId=${ingestionId}`);

  const costPublisher = makeCostPublisher();

  const exitCode = await runHandler({
    ingestionId,
    prisma,
    fetcher: globalThis.fetch.bind(globalThis),
    downloadFile: async (gcsRef: string) => {
      // gcsRef format: "<bucket>/<path>" or "gs://<bucket>/<path>"
      const ref = gcsRef.replace(/^gs:\/\//, "");
      const slash = ref.indexOf("/");
      if (slash < 0) throw new Error(`Invalid GCS reference: ${gcsRef}`);
      const bucket = ref.slice(0, slash);
      const path = ref.slice(slash + 1);
      const [buffer] = await storage.bucket(bucket).file(path).download();
      return buffer;
    },
    costPublisher,
  });

  await prisma.$disconnect();
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[worker] crash", e);
    process.exit(1);
  });
