/**
 * KAN-1219 fix-forward — Pub/Sub infrastructure self-healing (Memo 57 #5).
 *
 * # Layer 1 — defense-in-depth at infrastructure seams
 *
 * Production deployment of new topics has historically relied on Terraform
 * (`infra/terraform/*.tf`). When a new feature ships referencing a topic
 * that was NOT yet `terraform apply`-ed (the canonical KAN-1219 PROD trigger
 * on 2026-06-17: `vehicle.crawl_requested` published from `inventory-crawler.ts`
 * but never provisioned in GCP), the publish call throws NOT_FOUND. The
 * previous silent-swallow at inventory-crawler.ts:386-390 then left the
 * mutation returning success while the CrawlJob row sat in `pending`
 * forever — the canonical Memo 51 anchor #9 "stuck pending" UX failure.
 *
 * This module is the boot-time idempotent self-heal: at apps/api startup,
 * walk REQUIRED_TOPICS; for each, `.exists()` then `.create()` if absent;
 * then `.exists()/create()` each declared push subscription. Mirrors the
 * runtime pattern in `packages/api/src/services/pubsub-events.ts:158-167`
 * (`getOrCreateTopic`) — same idiom, hoisted to boot.
 *
 * # When to register a new topic here
 *
 * Layer 1 is the floor, NOT the ceiling. Terraform remains the durable
 * declaration (IAM bindings, retry policies, retention, OIDC tokens). Boot-
 * time self-heal exists so the day-1 GCP gap does not silently corrupt
 * operator UX. Register here when:
 *
 *   1. A new topic is published from app code AND
 *   2. The topic's terraform file is freshly authored OR has not yet been
 *      `terraform apply`-ed in PROD (e.g. demo / first-customer environments)
 *
 * Idempotency: `.exists()` returns false → create; `.exists()` returns true
 * → no-op. Safe to invoke on every cold start.
 *
 * # Push subscription contract
 *
 * Subscriptions registered here MUST also have an explicit Terraform record
 * (durable IAM + retry policy + retention + OIDC). Boot-time creation only
 * configures push endpoint + OIDC service account. Terraform owns the rest;
 * this module owns "exists at all".
 *
 * # Failure mode
 *
 * Boot is best-effort. If `.exists()` / `.create()` throws (IAM gap, project
 * misconfig, network blip), log + continue. Layer 2 (the publish-failure
 * handler in `inventory-crawler.ts`) catches the runtime publish failure
 * downstream and persists CrawlJob.status='failed' honestly. Boot does NOT
 * crash the API — a transient bootstrap failure must not gate the rest of
 * the surface.
 */

import { PubSub } from "@google-cloud/pubsub";
import type { PrismaClient } from "@prisma/client";

interface SubscriptionDef {
  name: string;
  pushEndpoint: string;
  oidcServiceAccount: string;
}

interface TopicDef {
  name: string;
  subscriptions: SubscriptionDef[];
}

/**
 * Topics + push subscriptions to self-heal at boot.
 *
 * Each entry mirrors a `terraform apply` declaration in `infra/terraform/`.
 * Boot-time self-heal is the floor; Terraform remains the canonical source
 * of truth for IAM, retry policy, retention, OIDC audience derivation.
 */
function buildRequiredTopics(env: NodeJS.ProcessEnv): TopicDef[] {
  const apiBaseUrl = env.API_PUBLIC_URL ?? "";
  const pubsubInvokerSa = env.PUBSUB_INVOKER_SA ?? "";
  return [
    {
      // KAN-1219 — vehicle.crawl_requested
      // Published by `packages/api/src/services/inventory-crawler.ts:382`
      // Consumed by `apps/api/src/subscribers/vehicle-crawl-push.ts`
      name: "vehicle.crawl_requested",
      subscriptions: [
        {
          name: "growth-api-vehicle-crawl",
          pushEndpoint: `${apiBaseUrl}/pubsub/vehicle-crawl`,
          oidcServiceAccount: pubsubInvokerSa,
        },
      ],
    },
  ];
}

/**
 * Idempotent topic + push-subscription self-heal. Logs each step; never
 * throws (best-effort boot). Returns a structured summary for the caller
 * to log at info level.
 */
export async function ensurePubsubInfrastructure(
  pubsub: PubSub,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ topicsEnsured: string[]; subscriptionsEnsured: string[]; errors: string[] }> {
  const topicsEnsured: string[] = [];
  const subscriptionsEnsured: string[] = [];
  const errors: string[] = [];

  for (const def of buildRequiredTopics(env)) {
    try {
      const topic = pubsub.topic(def.name);
      const [exists] = await topic.exists();
      if (!exists) {
        await topic.create();
        console.log(`[pubsub-bootstrap] created topic: ${def.name}`);
      }
      topicsEnsured.push(def.name);

      for (const subDef of def.subscriptions) {
        try {
          const sub = topic.subscription(subDef.name);
          const [subExists] = await sub.exists();
          if (!subExists) {
            // Only configure when both push endpoint + OIDC SA are present
            // (boot envs may lack either; Terraform handles full PROD config).
            if (subDef.pushEndpoint && subDef.oidcServiceAccount) {
              await topic.createSubscription(subDef.name, {
                pushConfig: {
                  pushEndpoint: subDef.pushEndpoint,
                  oidcToken: { serviceAccountEmail: subDef.oidcServiceAccount },
                },
              });
              console.log(
                `[pubsub-bootstrap] created subscription: ${subDef.name} → ${subDef.pushEndpoint}`,
              );
            } else {
              console.log(
                `[pubsub-bootstrap] skipping subscription ${subDef.name} — missing env (API_PUBLIC_URL/PUBSUB_INVOKER_SA)`,
              );
            }
          }
          subscriptionsEnsured.push(subDef.name);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          console.error(
            `[pubsub-bootstrap] subscription ${subDef.name} ensure failed: ${msg}`,
          );
          errors.push(`subscription:${subDef.name}:${msg}`);
        }
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[pubsub-bootstrap] topic ${def.name} ensure failed: ${msg}`);
      errors.push(`topic:${def.name}:${msg}`);
    }
  }

  return { topicsEnsured, subscriptionsEnsured, errors };
}

/**
 * Boot-entry guard — only runs when in a real Cloud Pub/Sub context
 * (no PUBSUB_EMULATOR_HOST, NODE_ENV !== 'test', GCP_PROJECT_ID set).
 * Mirrors `packages/api/src/lib/pubsub-client.ts` env-gating.
 */
export async function bootstrapPubsubAtStartup(): Promise<void> {
  if (process.env.PUBSUB_EMULATOR_HOST || process.env.NODE_ENV === "test") {
    return;
  }
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.log("[pubsub-bootstrap] GCP_PROJECT_ID not set — skipping boot self-heal");
    return;
  }
  const pubsub = new PubSub({ projectId });
  const summary = await ensurePubsubInfrastructure(pubsub);
  console.log(
    `[pubsub-bootstrap] complete: ${summary.topicsEnsured.length} topics, ` +
      `${summary.subscriptionsEnsured.length} subscriptions, ${summary.errors.length} errors`,
  );
}

/**
 * Layer 3b — retroactive stuck-pending CrawlJob self-heal.
 *
 * On 2026-06-17 KAN-1219 PROD, the day-1 Pub/Sub provisioning gap (Memo 51 #9)
 * combined with the now-fixed silent-swallow at inventory-crawler.ts:386-390
 * (Memo 42 affordance-honesty) to leave CrawlJob rows in `status='pending'`
 * forever — never picked up by any worker, never transitioned, never visible
 * to the operator as a failure. Layer 2 fixes the silent-swallow for new
 * crawls; this function rescues PRE-EXISTING zombies on boot.
 *
 * Heuristic: any CrawlJob still `pending` after STUCK_THRESHOLD_MS (5 min)
 * could not realistically still be in flight. Push subscriptions ack within
 * seconds-to-minutes; a >5min pending row is by definition orphaned.
 * No `publishedMessageId` column exists on CrawlJob, so we cannot distinguish
 * "publish never reached GCP" from "publish reached but subscriber crashed".
 * The remediation is identical either way — transition to failed with the
 * canonical `publish_infrastructure_gap` cancelReason so the operator sees
 * a Cancel-actionable failed state instead of the Memo 51 #9 zombie pending.
 *
 * Idempotent: subsequent boots match no rows (status already terminal).
 * Best-effort: errors logged + swallowed; never gates API boot.
 */
const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export async function recoverStuckPendingCrawlJobs(
  prisma: PrismaClient,
): Promise<{ recovered: number; errors: string[] }> {
  const errors: string[] = [];
  try {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
    const stuck = await prisma.crawlJob.findMany({
      where: { status: "pending", createdAt: { lt: cutoff } },
      select: { id: true, listingUrl: true },
    });
    if (stuck.length === 0) {
      return { recovered: 0, errors };
    }
    console.log(
      `[pubsub-bootstrap] recovering ${stuck.length} stuck-pending CrawlJob(s) (>5min old)`,
    );
    const now = new Date();
    for (const job of stuck) {
      try {
        await prisma.crawlJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            cancelReason: "publish_infrastructure_gap",
            errorSamples: [
              {
                url: job.listingUrl,
                errorVariant: "publish_failed",
                message:
                  "CrawlJob exceeded 5min in pending — Pub/Sub publish or subscriber delivery never completed. Recovered at boot (KAN-1219 Layer 3b).",
              },
            ],
            completedAt: now,
          },
        });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.error(`[pubsub-bootstrap] failed to recover CrawlJob ${job.id}: ${msg}`);
        errors.push(`crawlJob:${job.id}:${msg}`);
      }
    }
    return { recovered: stuck.length - errors.length, errors };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[pubsub-bootstrap] stuck-pending sweep failed: ${msg}`);
    errors.push(`sweep:${msg}`);
    return { recovered: 0, errors };
  }
}
