/**
 * KAN-862 — Account Page Cohort 5: Cloud Tasks client wrapper.
 *
 * Enqueues an HTTP task targeting growth-api's
 * /internal/account-detect-handler endpoint. OIDC-authenticated as
 * pubsub-invoker (the canonical SA per
 * `class_structural_elimination/audience_mismatch.md`); the dispatch-
 * time token is minted by the Cloud Tasks Service Agent against the
 * tokenCreator binding provisioned in
 * infra/terraform/account-detect.tf.
 *
 * Queue config (Terraform-managed):
 *   max_dispatches_per_second = 5
 *   max_concurrent_dispatches = 10
 *   max_attempts              = 3
 *   min_backoff               = 30s
 *   max_backoff               = 600s
 *
 * Test seam: __setTasksClientForTest() injects a mock so unit tests
 * don't hit the real Cloud Tasks API.
 */
import { CloudTasksClient } from "@google-cloud/tasks";

const QUEUE_NAME = "account-detect";
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "growth-493400";
const REGION = process.env.GOOGLE_CLOUD_REGION ?? "us-central1";

// pubsub-invoker SA — the OIDC identity Cloud Tasks dispatches as.
// Cloud Tasks Service Agent has roles/iam.serviceAccountTokenCreator
// on this SA (see Terraform).
const OIDC_SERVICE_ACCOUNT =
  process.env.ACCOUNT_DETECT_OIDC_SA ??
  `pubsub-invoker@${PROJECT_ID}.iam.gserviceaccount.com`;

// Handler URL — defaults to growth-api Cloud Run service. Tests can
// override via env var.
const HANDLER_URL =
  process.env.ACCOUNT_DETECT_HANDLER_URL ??
  `https://growth-api-biut5gfhuq-uc.a.run.app/internal/account-detect-handler`;

let _client: CloudTasksClient | null = null;

interface MinimalTasksClient {
  createTask: (req: unknown) => Promise<unknown>;
  queuePath: (project: string, location: string, queue: string) => string;
}

function getClient(): MinimalTasksClient {
  if (!_client) _client = new CloudTasksClient();
  return _client as unknown as MinimalTasksClient;
}

/** Test seam — inject a mock CloudTasksClient. */
export function __setTasksClientForTest(client: MinimalTasksClient | null): void {
  _client = client as unknown as CloudTasksClient | null;
}

export interface AccountDetectTaskBody {
  tenantId: string;
  jobId: string;
  websiteUrl: string;
}

/**
 * Enqueue a detect-from-website task. Returns the task name (Cloud
 * Tasks resource path) for telemetry; the API uses this only for
 * logging — the jobId is the canonical correlation ID.
 */
export async function enqueueAccountDetectTask(
  body: AccountDetectTaskBody,
): Promise<{ taskName: string }> {
  const client = getClient();
  const parent = client.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

  const task = {
    httpRequest: {
      httpMethod: "POST" as const,
      url: HANDLER_URL,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      oidcToken: {
        serviceAccountEmail: OIDC_SERVICE_ACCOUNT,
        // audience defaults to the URL — matches verifyPubsubOidc's
        // expected audience derivation (request.url-based).
      },
    },
  };

  const [response] = (await client.createTask({ parent, task })) as [
    { name?: string },
  ];
  return { taskName: response?.name ?? "" };
}
