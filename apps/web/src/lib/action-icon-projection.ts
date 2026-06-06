/**
 * KAN-1107 — Action / channel icon projection helper.
 *
 * Maps Action.channel + agentType + status into Lucide icons + Tailwind
 * color classes for the Dashboard Agent Actions panel + Decision Feed
 * channel chips. Class-fix extraction from
 * apps/web/src/app/settings/page.tsx:545-550 (4-channel mapping) + extends
 * to cover non-channel action types (CRM-sync, escalation, meeting).
 *
 * Phase 1 vocab audit 2026-06-06: Action table is empty in PROD. Vocab
 * grounded from:
 *   - Action.channel values: schema-allows any String (no enum). Settings
 *     page enumerates 4 channels in active use: email, sms, whatsapp,
 *     messenger.
 *   - Action.status values: cribbed from CommunicationAgent dispatch path
 *     (communication-agent.d.ts:205): pending, sent, delivered, failed,
 *     bounced, blocked, rejected.
 *   - Decision.actionType empirical sample (50 rows): send_email,
 *     send_message, send_follow_up.
 *
 * Defensive: unknown values fall back to a generic muted badge / generic
 * Activity icon. Catches future enum extensions gracefully.
 *
 * Sibling consumers (extraction targets):
 *   - apps/web/src/app/settings/page.tsx:545-550 — channelIcons const
 *   - apps/web/src/app/dashboard/page.tsx — Agent Actions panel + Decision
 *     Feed channel chip
 */
import {
  Mail,
  Phone,
  MessageCircle,
  MessagesSquare,
  MessageSquare,
  Calendar,
  Flag,
  AlertTriangle,
  Activity,
} from 'lucide-react';

export interface ChannelIconConfig {
  icon: typeof Mail;
  /** Tailwind color class with design tokens. */
  color: string;
  /** Operator-facing label. */
  label: string;
}

const UNKNOWN_CHANNEL: ChannelIconConfig = {
  icon: Activity,
  color: 'bg-muted text-muted-foreground',
  label: 'Other',
};

/**
 * Channel → icon mapping. Covers 4 communication channels used in PROD
 * settings/page.tsx + extended for dashboard panel use.
 */
const CHANNEL_MAP: Record<string, ChannelIconConfig> = {
  email: { icon: Mail, color: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]', label: 'Email' },
  sms: { icon: Phone, color: 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]', label: 'SMS' },
  whatsapp: { icon: MessageCircle, color: 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]', label: 'WhatsApp' },
  messenger: { icon: MessagesSquare, color: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]', label: 'Messenger' },
};

/**
 * agentType → icon mapping. Covers non-channel action types (CRM-sync,
 * escalation, meeting). Phase 1 vocab is illustrative — extend as new
 * agent types ship.
 */
const AGENT_TYPE_MAP: Record<string, ChannelIconConfig> = {
  meeting_agent: { icon: Calendar, color: 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]', label: 'Meeting' },
  crm_sync_agent: { icon: Flag, color: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]', label: 'CRM Sync' },
  escalation_agent: { icon: AlertTriangle, color: 'bg-red-100 text-red-600', label: 'Escalation' },
};

/**
 * Get icon + color + label for an Action row. Resolution priority:
 *   1. channel (when non-null) — communication-channel rendering
 *   2. agentType — non-channel actions like CRM-sync
 *   3. fallback — generic Activity icon
 */
export function actionIcon(action: { channel?: string | null; agentType?: string | null }): ChannelIconConfig {
  if (action.channel) {
    const channelConfig = CHANNEL_MAP[action.channel.toLowerCase()];
    if (channelConfig) return channelConfig;
  }
  if (action.agentType) {
    const agentConfig = AGENT_TYPE_MAP[action.agentType];
    if (agentConfig) return agentConfig;
  }
  return UNKNOWN_CHANNEL;
}

/**
 * Sole helper kept exported for sibling consumer at
 * apps/web/src/app/settings/page.tsx — the channel-only subset of CHANNEL_MAP.
 * Preserves the original Record<string, {icon, color}> shape from KAN-985.
 */
export function channelIcon(channel: string): { icon: typeof Mail; color: string } | undefined {
  const cfg = CHANNEL_MAP[channel.toLowerCase()];
  return cfg ? { icon: cfg.icon, color: cfg.color } : undefined;
}

/**
 * Decision Feed channel chip — derives channel label from hybrid source
 * (Q6 Phase 1 lock: Action[0].channel when present + actionType proxy).
 * Returns '—' for null/unknown to signal "not yet dispatched / ambiguous"
 * (operator-honest rendering for Action-empty PROD state).
 */
export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return '—';
  return CHANNEL_MAP[channel.toLowerCase()]?.label ?? channel;
}

/**
 * Status badge mapping for Agent Actions panel. Vocab cribbed from
 * CommunicationAgent.d.ts. Defensive: unknown statuses render with generic
 * muted treatment.
 */
export interface StatusBadgeConfig {
  /** Operator-facing label. */
  label: string;
  /** Tailwind color class for status text. */
  className: string;
}

const STATUS_MAP: Record<string, StatusBadgeConfig> = {
  pending: { label: '⏳ Pending', className: 'text-amber-600' },
  sent: { label: '✓ Sent', className: 'text-[var(--ds-emerald-700)]' },
  delivered: { label: '✓ Delivered', className: 'text-[var(--ds-emerald-700)]' },
  failed: { label: '✗ Failed', className: 'text-red-600' },
  bounced: { label: '✗ Bounced', className: 'text-red-600' },
  blocked: { label: '⊘ Blocked', className: 'text-red-600' },
  rejected: { label: '⊘ Rejected', className: 'text-red-600' },
};

export function statusBadge(status: string): StatusBadgeConfig {
  return STATUS_MAP[status.toLowerCase()] ?? { label: status, className: 'text-muted-foreground' };
}
