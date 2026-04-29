/**
 * KAN-718 — demo-only fixtures for /conversations.
 *
 * Filename pattern `demo-fixtures.ts` is one of the canonical demo-gating
 * patterns the May 6 drift sweep recognizes (per `apps/web/src/lib/demo-mode.ts`
 * docstring). All mock content lives here, NOT at module scope inside
 * `page.tsx`, so the audit doesn't false-positive on intentional demo data.
 *
 * Page imports these only when `isDemoMode()` is true. Outside demo mode, the
 * page renders a "coming soon" empty state and these fixtures are inert.
 *
 * KAN-757 (Sprint 5+) will refresh fixture quality once we know what kinds of
 * demos sales runs.
 */
import { Mail, Phone, MessageCircle } from "lucide-react";

export interface ConversationMessage {
  id: number;
  sender: "ai" | "contact";
  text: string;
  time: string;
  channel: string;
  pending?: boolean;
}

export interface DemoConversation {
  id: number;
  contact: string;
  company: string;
  avatar: string;
  channel: string;
  channelIcon: typeof Mail;
  lastMessage: string;
  time: string;
  unread: boolean;
  aiHandled: boolean;
  escalated?: boolean;
  strategy: string;
  confidence: number;
  objective: string;
  messages: ConversationMessage[];
}

export const demoConversations: DemoConversation[] = [
  {
    id: 1,
    contact: "Sarah Chen",
    company: "Meridian Consulting",
    avatar: "SC",
    channel: "Email",
    channelIcon: Mail,
    lastMessage: "Thanks for the proposal — I have a few questions about the implementation timeline...",
    time: "2m ago",
    unread: true,
    aiHandled: true,
    strategy: "Direct Conversion",
    confidence: 92,
    objective: "Close Deal",
    messages: [
      { id: 1, sender: "ai", text: "Hi Sarah — following up on the proposal I sent Thursday. I noticed you opened it several times, so I wanted to check if you had any questions about the pricing or implementation approach.", time: "10:12 AM", channel: "Email" },
      { id: 2, sender: "contact", text: "Thanks for the proposal — I have a few questions about the implementation timeline. Can we do a phased rollout instead of the big-bang approach?", time: "10:18 AM", channel: "Email" },
      { id: 3, sender: "ai", text: "Absolutely! A phased rollout is something we recommend for teams your size. I can put together a revised timeline showing a 3-phase approach — would next Tuesday work for a 20-minute walkthrough?", time: "10:19 AM", channel: "Email", pending: true },
    ],
  },
  {
    id: 2,
    contact: "Marcus Reid",
    company: "Forge Manufacturing",
    avatar: "MR",
    channel: "SMS",
    channelIcon: Phone,
    lastMessage: "Got it, Thursday 2pm works for the demo. See you then!",
    time: "8m ago",
    unread: false,
    aiHandled: true,
    strategy: "Guided Assistance",
    confidence: 74,
    objective: "Book Meeting",
    messages: [
      { id: 1, sender: "ai", text: "Hi Marcus — based on your interest in our analytics module, I'd love to set up a quick demo. Would Thursday or Friday work better this week?", time: "9:45 AM", channel: "SMS" },
      { id: 2, sender: "contact", text: "Got it, Thursday 2pm works for the demo. See you then!", time: "9:52 AM", channel: "SMS" },
    ],
  },
  {
    id: 3,
    contact: "Brian Walker",
    company: "Vertex Analytics",
    avatar: "BW",
    channel: "Email",
    channelIcon: Mail,
    lastMessage: "I'm not sure this is the right fit for us anymore...",
    time: "1h ago",
    unread: true,
    aiHandled: false,
    strategy: "Re-engagement",
    confidence: 31,
    objective: "Re-engage",
    escalated: true,
    messages: [
      { id: 1, sender: "ai", text: "Hi Brian — it's been a couple weeks since we last connected. I wanted to check in and see if there's anything I can help with regarding your evaluation.", time: "9:00 AM", channel: "Email" },
      { id: 2, sender: "contact", text: "I'm not sure this is the right fit for us anymore. We've had some internal changes and the budget situation has shifted.", time: "9:45 AM", channel: "Email" },
    ],
  },
  {
    id: 4,
    contact: "Lisa Park",
    company: "Vantage Real Estate",
    avatar: "LP",
    channel: "WhatsApp",
    channelIcon: MessageCircle,
    lastMessage: "Proposal looks great! Let me run it by my CFO this week.",
    time: "2h ago",
    unread: false,
    aiHandled: true,
    strategy: "Direct Conversion",
    confidence: 88,
    objective: "Close Deal",
    messages: [
      { id: 1, sender: "ai", text: "Hi Lisa — I've attached the custom proposal based on our conversation. It includes the enterprise package with the integrations you requested.", time: "8:30 AM", channel: "WhatsApp" },
      { id: 2, sender: "contact", text: "Proposal looks great! Let me run it by my CFO this week.", time: "8:55 AM", channel: "WhatsApp" },
      { id: 3, sender: "ai", text: "Sounds good! I'll follow up Thursday if I haven't heard back. In the meantime, here's a case study from a similar real estate firm that saw 40% faster closings.", time: "8:56 AM", channel: "WhatsApp" },
    ],
  },
  {
    id: 5,
    contact: "Jenny Liu",
    company: "Catalyst Ventures",
    avatar: "JL",
    channel: "Email",
    channelIcon: Mail,
    lastMessage: "This case study is really helpful. Can you send more about the fintech use case?",
    time: "3h ago",
    unread: true,
    aiHandled: true,
    strategy: "Trust Building",
    confidence: 58,
    objective: "Qualify Lead",
    messages: [
      { id: 1, sender: "ai", text: "Hi Jenny — I thought you might find this case study interesting. It's from a fintech company similar to Catalyst that improved their pipeline velocity by 3x.", time: "7:15 AM", channel: "Email" },
      { id: 2, sender: "contact", text: "This case study is really helpful. Can you send more about the fintech use case?", time: "8:02 AM", channel: "Email" },
    ],
  },
  {
    id: 6,
    contact: "Rachel Kim",
    company: "Apex Logistics",
    avatar: "RK",
    channel: "Email",
    channelIcon: Mail,
    lastMessage: "Quick question — does your platform integrate with SAP?",
    time: "4h ago",
    unread: false,
    aiHandled: true,
    strategy: "Guided Assistance",
    confidence: 81,
    objective: "Qualify Lead",
    messages: [
      { id: 1, sender: "contact", text: "Quick question — does your platform integrate with SAP?", time: "6:30 AM", channel: "Email" },
      { id: 2, sender: "ai", text: "Great question! Yes, we have a native SAP integration that syncs contacts, deals, and activities bi-directionally. I can walk you through the setup — it typically takes about 15 minutes. Want me to schedule a quick call?", time: "6:31 AM", channel: "Email" },
    ],
  },
];
