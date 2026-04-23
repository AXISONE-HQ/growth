/**
 * Wedge Playbook Templates — KAN-655 Day-1 Wedge
 *
 * Hardcoded playbook step definitions. Each opportunity type has exactly one
 * playbook. Replaces full KAN-654 Playbook Composer for MVP wedge demo.
 *
 * Location: packages/api/src/services/wedge-playbooks.ts
 *
 * Each playbook step gets converted into a `playbookStepContext` and passed
 * to runDecisionForContact (KAN-649 adapter pattern). The existing engine
 * executes the step within the constraint rather than deciding freely.
 */

export interface WedgePlaybookStep {
  day: number;
  channel: 'email' | 'sms' | 'meta';
  intent: string;             // short human label
  instruction: string;        // exact instruction to the LLM
  allowedActions: string[];   // zod-enforced downstream
}

export interface WedgePlaybookTemplate {
  slug: string;
  name: string;
  description: string;
  successEvent: string;
  steps: WedgePlaybookStep[];
}

export const WEDGE_PLAYBOOKS: Record<string, WedgePlaybookTemplate> = {
  dormant_reactivation_14d: {
    slug: 'dormant_reactivation_14d',
    name: 'Dormant Reactivation — 14 day',
    description: 'Re-engage contacts that have gone cold with a 3-touch sequence.',
    successEvent: 'contact.replied',
    steps: [
      {
        day: 0,
        channel: 'email',
        intent: 'personalized_check_in',
        instruction:
          'Send a short, personal email acknowledging the lapse in contact. Reference their name and company if known. End with one open-ended question. No pitch.',
        allowedActions: ['send_email'],
      },
      {
        day: 7,
        channel: 'email',
        intent: 'value_case_study',
        instruction:
          'Send a relevant case study or data point related to their industry. Keep it under 4 sentences. CTA: reply if interested.',
        allowedActions: ['send_email'],
      },
      {
        day: 14,
        channel: 'email',
        intent: 'final_breakup',
        instruction:
          'Send a polite breakup email: "Is this still a priority? If not, no problem — I\\'ll stop reaching out." Strict 3-sentence cap.',
        allowedActions: ['send_email'],
      },
    ],
  },

  high_intent_follow_up: {
    slug: 'high_intent_follow_up',
    name: 'High Intent Follow-Up',
    description: 'Rapid 3-touch sequence for fresh leads that haven\'t been worked.',
    successEvent: 'meeting_scheduled',
    steps: [
      {
        day: 0,
        channel: 'email',
        intent: 'acknowledge_interest',
        instruction:
          'Send a warm email acknowledging their interest. Reference the source of their inquiry if in context. Include one specific question about their current challenge.',
        allowedActions: ['send_email'],
      },
      {
        day: 2,
        channel: 'sms',
        intent: 'qualify',
        instruction:
          'Send a short SMS (under 160 chars) asking a qualifying question about timeline or budget. Friendly, low-pressure. Mention AxisOne by name.',
        allowedActions: ['send_sms'],
      },
      {
        day: 4,
        channel: 'email',
        intent: 'book_call',
        instruction:
          'Send an email offering a 15-minute intro call. Include one concrete date/time suggestion and a Calendly-style link (placeholder for now). Max 4 sentences.',
        allowedActions: ['send_email'],
      },
    ],
  },

  data_enrichment_request: {
    slug: 'data_enrichment_request',
    name: 'Data Enrichment Request',
    description: 'One-touch outreach asking for missing profile fields.',
    successEvent: 'contact.profile_updated',
    steps: [
      {
        day: 0,
        channel: 'email',
        intent: 'request_profile_info',
        instruction:
          'Send a brief email acknowledging incomplete data on file and asking them to confirm their role, company size, and primary use case via a one-click reply. Be transparent that this helps us serve them better.',
        allowedActions: ['send_email'],
      },
    ],
  },
};

/**
 * Build a playbookStepContext for KAN-649 runDecisionForContact.
 * Called once per enrolled entity per step.
 */
export function buildPlaybookStepContext(playbookSlug: string, stepIndex: number) {
  const playbook = WEDGE_PLAYBOOKS[playbookSlug];
  if (!playbook) throw new Error(`Unknown playbook: ${playbookSlug}`);
  const step = playbook.steps[stepIndex];
  if (!step) throw new Error(`Playbook ${playbookSlug} has no step ${stepIndex}`);

  return {
    playbookStep: `${playbook.slug}:day_${step.day}`,
    instruction: step.instruction,
    allowedActions: step.allowedActions,
    channel: step.channel,
    additionalContext: {
      playbookName: playbook.name,
      intent: step.intent,
      day: step.day,
    },
  };
}
