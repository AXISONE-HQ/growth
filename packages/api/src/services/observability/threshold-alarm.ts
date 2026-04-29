/**
 * KAN-745 PR B — threshold-breach structured-log emitter.
 *
 * Dual-format log per reinforcement #2: a human-readable message line that
 * `grep '[agentic-cost]'` finds, AND a structured JSON payload that Cloud
 * Monitoring / Cloud Logging parses for label-based alerting (KAN-759
 * follow-up wires the alert policy on these labels).
 *
 * Cloud Run + Cloud Logging convention: when console.warn is called with a
 * second argument that has shape `{ severity, "logging.googleapis.com/labels", ...}`
 * the runtime promotes those fields into the structured log entry.
 */

const SHADOW_RATIO_THRESHOLD = 2.5;

export interface ThresholdEvalInput {
  tenantId: string;
  hourBucket: Date;
  agenticUsd: number;
  nonAgenticUsd: number;
}

export interface ThresholdEvalResult {
  ratio: number;
  breach: boolean;
  threshold: number;
}

/**
 * Compute the shadow ratio + breach flag. `nonAgenticUsd === 0` returns
 * `ratio = Infinity` only if `agenticUsd > 0`; else `ratio = 0` (no traffic
 * at all in the window). Caller uses the breach flag, not raw ratio, to
 * decide whether to alarm.
 */
export function evaluateThreshold(input: ThresholdEvalInput): ThresholdEvalResult {
  const { agenticUsd, nonAgenticUsd } = input;
  let ratio: number;
  if (nonAgenticUsd === 0) {
    ratio = agenticUsd === 0 ? 0 : Infinity;
  } else {
    ratio = agenticUsd / nonAgenticUsd;
  }
  return {
    ratio,
    breach: ratio > SHADOW_RATIO_THRESHOLD,
    threshold: SHADOW_RATIO_THRESHOLD,
  };
}

/**
 * Emit a structured warning when the shadow ratio breaches threshold.
 * Idempotent on the caller — caller should rate-limit (e.g., once per
 * tenant per hourBucket) to avoid log flooding.
 */
export function emitThresholdAlarm(input: ThresholdEvalInput): ThresholdEvalResult {
  const result = evaluateThreshold(input);
  if (!result.breach) return result;

  const { tenantId, hourBucket, agenticUsd, nonAgenticUsd } = input;
  const ratioStr = Number.isFinite(result.ratio) ? `${result.ratio.toFixed(2)}x` : 'inf';

  // Dual-format: human-grep-friendly message + structured payload for
  // Cloud Logging label-based alerting (KAN-759 wires the alert policy).
  console.warn(
    `[agentic-cost] tenant=${tenantId} shadow_ratio=${ratioStr} window=${hourBucket.toISOString()} agentic=$${agenticUsd.toFixed(4)} non_agentic=$${nonAgenticUsd.toFixed(4)} threshold=${result.threshold}`,
    {
      severity: 'WARNING',
      'logging.googleapis.com/labels': {
        service: 'growth-api',
        event: 'agentic-cost-threshold-breach',
        tenantId,
      },
      metric: {
        shadowRatio: Number.isFinite(result.ratio) ? result.ratio : null,
        agenticUsd,
        nonAgenticUsd,
        threshold: result.threshold,
        hourBucket: hourBucket.toISOString(),
      },
    },
  );

  return result;
}
