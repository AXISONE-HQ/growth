/**
 * KAN-862 — Account Page Cohort 5: typed Pub/Sub publishers for the
 * detect-from-website lifecycle topics.
 *
 * Five topics provisioned via infra/terraform/account-detect.tf
 * (sibling Terraform PR per Fred's pre-flight ritual):
 *   - account.detect_started
 *   - account.detect_progress
 *   - account.detect_completed
 *   - account.detect_failed
 *   - account.detect_dead_letter
 *
 * Publish failures are LOGGED, NOT THROWN — the lifecycle event is
 * best-effort signal for the audit log + UI telemetry. The actual scan
 * result lands in AccountFieldDetection rows + AccountProfile.detectStatus
 * regardless of whether the event publish succeeds.
 *
 * Cohort 6 wires push subscriptions on these topics for the audit-log
 * subscriber + DriftBanner UI.
 */
import { PubSub } from "@google-cloud/pubsub";

const TOPIC_STARTED = "account.detect_started";
const TOPIC_PROGRESS = "account.detect_progress";
const TOPIC_COMPLETED = "account.detect_completed";
const TOPIC_FAILED = "account.detect_failed";
const TOPIC_DEAD_LETTER = "account.detect_dead_letter";

let _pubsub: PubSub | null = null;

function getPubSubClient(): PubSub {
  if (!_pubsub) _pubsub = new PubSub();
  return _pubsub;
}

/** Test seam — replace the singleton with a mock or null. */
export function __setAccountDetectPubsubForTest(client: PubSub | null): void {
  _pubsub = client;
}

export interface DetectStartedEvent {
  tenantId: string;
  jobId: string;
  websiteUrl: string;
  enqueuedAt: string; // ISO timestamp
}

export interface DetectProgressEvent {
  tenantId: string;
  jobId: string;
  phase: "fetching" | "extracting";
  notes?: string[];
}

export interface DetectCompletedEvent {
  tenantId: string;
  jobId: string;
  proposalCount: number;
  durationMs: number;
}

export interface DetectFailedEvent {
  tenantId: string;
  jobId: string;
  errorCode: "timeout" | "fetch_failed" | "llm_error" | "unknown";
  errorMessage: string;
  attempt: number;
}

export interface DetectDeadLetterEvent {
  tenantId: string;
  jobId: string;
  websiteUrl: string;
  errorCode: string;
  errorMessage: string;
  /** Cloud Tasks attempt count when the handler finally gave up. Equal
   * to MAX_ATTEMPTS (3) at dead-letter time. */
  retryCount: number;
  /** ISO timestamp of the handler invocation that triggered the
   * dead-letter publish. Best approximation of "when did the scan die"
   * available to the handler — Cloud Tasks doesn't pass the original
   * task-enqueue timestamp through retries. Cohort 6 audit subscriber
   * can read this for the audit-log entry. */
  originalTimestamp: string;
}

async function publish<T>(topic: string, payload: T): Promise<void> {
  try {
    const data = Buffer.from(JSON.stringify(payload));
    await getPubSubClient().topic(topic).publishMessage({ data });
  } catch (err) {
    console.error(`[account-detect-publishers] ${topic} publish failed:`, err);
    // Swallow — best-effort by design. The actual scan state lives in
    // AccountFieldDetection + AccountProfile; the event is signal.
  }
}

export async function publishDetectStarted(event: DetectStartedEvent): Promise<void> {
  return publish(TOPIC_STARTED, event);
}

export async function publishDetectProgress(event: DetectProgressEvent): Promise<void> {
  return publish(TOPIC_PROGRESS, event);
}

export async function publishDetectCompleted(event: DetectCompletedEvent): Promise<void> {
  return publish(TOPIC_COMPLETED, event);
}

export async function publishDetectFailed(event: DetectFailedEvent): Promise<void> {
  return publish(TOPIC_FAILED, event);
}

export async function publishDetectDeadLetter(event: DetectDeadLetterEvent): Promise<void> {
  return publish(TOPIC_DEAD_LETTER, event);
}

export const ACCOUNT_DETECT_TOPICS = {
  started: TOPIC_STARTED,
  progress: TOPIC_PROGRESS,
  completed: TOPIC_COMPLETED,
  failed: TOPIC_FAILED,
  deadLetter: TOPIC_DEAD_LETTER,
} as const;
