'use client';

import {
  MessageSquare, Search, Filter, Clock, Mail, Phone, MessageCircle,
  Send, ChevronDown, MoreHorizontal, Paperclip, Sparkles, User,
  ArrowUpRight, CheckCheck, AlertTriangle, Zap, Star, Archive
} from 'lucide-react';
import { useState } from 'react';

/* ─── Mock Data ─────────────────────────────────────── */
const conversations = [
  {
    id: 1,
    contact: 'Sarah Chen',
    company: 'Meridian Consulting',
    avatar: 'SC',
    channel: 'Email',
    channelIcon: Mail,
    lastMessage: 'Thanks for the proposal — I have a few questions about the implementation timeline...',
    time: '2m ago',
    unread: true,
    aiHandled: true,
    strategy: 'Direct Conversion',
    confidence: 92,
    objective: 'Close Deal',
    messages: [
      { id: 1, sender: 'ai', text: 'Hi Sarah — following up on the proposal I sent Thursday. I noticed you opened it several times, so I wanted to check if you had any questions about the pricing or implementation approach.', time: '10:12 AM', channel: 'Email' },
      { id: 2, sender: 'contact', text: 'Thanks for the proposal — I have a few questions about the implementation timeline. Can we do a phased rollout instead of the big-bang approach?', time: '10:18 AM', channel: 'Email' },
      { id: 3, sender: 'ai', text: 'Absolutely! A phased rollout is something we recommend for teams your size. I can put together a revised timeline showing a 3-phase approach — would next Tuesday work for a 20-minute walkthrough?', time: '10:19 AM', channel: 'Email', pending: true },
    ],
  },
  {
    id: 2,
    contact: 'Marcus Reid',
    company: 'Forge Manufacturing',
    avatar: 'MR',
    channel: 'SMS',
    channelIcon: Phone,
    lastMessage: 'Got it, Thursday 2pm works for the demo. See you then!',
    time: '8m ago',
    unread: false,
    aiHandled: true,
    strategy: 'Guided Assistance',
    confidence: 74,
    objective: 'Book Meeting',
    messages: [
      { id: 1, sender: 'ai', text: 'Hi Marcus — based on your interest in our analytics module, I\'d love to set up a quick demo. Would Thursday or Friday work better this week?', time: '9:45 AM', channel: 'SMS' },
      { id: 2, sender: 'contact', text: 'Got it, Thursday 2pm works for the demo. See you then!', time: '9:52 AM', channel: 'SMS' },
    ],
  },
  {
    id: 3,
    contact: 'Brian Walker',
    company: 'Vertex Analytics',
    avatar: 'BW',
    channel: 'Email',
    channelIcon: Mail,
    lastMessage: 'I\'m not sure this is the right fit for us anymore...',
    time: '1h ago',
    unread: true,
    aiHandled: false,
    strategy: 'Re-engagement',
    confidence: 31,
    objective: 'Re-engage',
    escalated: true,
    messages: [
      { id: 1, sender: 'ai', text: 'Hi Brian — it\'s been a couple weeks since we last connected. I wanted to check in and see if there\'s anything I can help with regarding your evaluation.', time: '9:00 AM', channel: 'Email' },
      { id: 2, sender: 'contact', text: 'I\'m not sure this is the right fit for us anymore. We\'ve had some internal changes and the budget situation has shifted.', time: '9:45 AM', channel: 'Email' },
    ],
  },
  {
    id: 4,
    contact: 'Lisa Park',
    company: 'Vantage Real Estate',
    avatar: 'LP',
    channel: 'WhatsApp',
    channelIcon: MessageCircle,
    lastMessage: 'Proposal looks great! Let me run it by my CFO this week.',
    time: '2h ago',
    unread: false,
    aiHandled: true,
    strategy: 'Direct Conversion',
    confidence: 88,
    objective: 'Close Deal',
    messages: [
      { id: 1, sender: 'ai', text: 'Hi Lisa — I\'ve attached the custom proposal based on our conversation. It includes the enterprise package with the integrations you requested.', time: '8:30 AM', channel: 'WhatsApp' },
      { id: 2, sender: 'contact', text: 'Proposal looks great! Let me run it by my CFO this week.', time: '8:55 AM', channel: 'WhatsApp' },
      { id: 3, sender: 'ai', text: 'Sounds good! I\'ll follow up Thursday if I haven\'t heard back. In the meantime, here\'s a case study from a similar real estate firm that saw 40% faster closings.', time: '8:56 AM', channel: 'WhatsApp' },
    ],
  },
  {
    id: 5,
    contact: 'Jenny Liu',
    company: 'Catalyst Ventures',
    avatar: 'JL',
    channel: 'Email',
    channelIcon: Mail,
    lastMessage: 'This case study is really helpful. Can you send more about the fintech use case?',
    time: '3h ago',
    unread: true,
    aiHandled: true,
    strategy: 'Trust Building',
    confidence: 58,
    objective: 'Qualify Lead',
    messages: [
      { id: 1, sender: 'ai', text: 'Hi Jenny — I thought you might find this case study interesting. It\'s from a fintech company similar to Catalyst that improved their pipeline velocity by 3x.', time: '7:15 AM', channel: 'Email' },
      { id: 2, sender: 'contact', text: 'This case study is really helpful. Can you send more about the fintech use case?', time: '8:02 AM', channel: 'Email' },
    ],
  },
  {
    id: 6,
    contact: 'Rachel Kim',
    company: 'Apex Logistics',
    avatar: 'RK',
    channel: 'Email',
    channelIcon: Mail,
    lastMessage: 'Quick question — does your platform integrate with SAP?',
    time: '4h ago',
    unread: false,
    aiHandled: true,
    strategy: 'Guided Assistance',
    confidence: 81,
    objective: 'Qualify Lead',
    messages: [
      { id: 1, sender: 'contact', text: 'Quick question — does your platform integrate with SAP?', time: '6:30 AM', channel: 'Email' },
      { id: 2, sender: 'ai', text: 'Great question! Yes, we have a native SAP integration that syncs contacts, deals, and activities bi-directionally. I can walk you through the setup — it typically takes about 15 minutes. Want me to schedule a quick call?', time: '6:31 AM', channel: 'Email' },
    ],
  },
];

const channelFilters = ['All', 'Email', 'SMS', 'WhatsApp'];
const statusFilters = ['All', 'AI Handled', 'Escalated', 'Unread'];

/* ─── Component ─────────────────────────────────────── */
export default function ConversationsPage() {
  const [selectedConversation, setSelectedConversation] = useState(conversations[0]);
  const [channelFilter, setChannelFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = conversations.filter((c) => {
    if (channelFilter !== 'All' && c.channel !== channelFilter) return false;
    if (statusFilter === 'Unread' && !c.unread) return false;
    if (statusFilter === 'AI Handled' && !c.aiHandled) return false;
    if (statusFilter === 'Escalated' && !c.escalated) return false;
    if (searchQuery && !c.contact.toLowerCase().includes(searchQuery.toLowerCase()) && !c.company.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const confClass = (c: number) =>
    c >= 80 ? 'bg-emerald-50 text-emerald-700' : c >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';

  return (
    <div className="flex h-[calc(100vh-57px)]">
      {/* Left: Conversation List */}
      <div className="w-[380px] border-r border-gray-200 flex flex-col bg-white">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Conversations</h2>
            <span className="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">
              {conversations.length} active
            </span>
          </div>
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex gap-1">
              {channelFilters.map((f) => (
                <button
                  key={f}
                  onClick={() => setChannelFilter(f)}
                  className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors ${
                    channelFilter === f ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto">
          {filtered.map((conv) => (
            <button
              key={conv.id}
              onClick={() => setSelectedConversation(conv)}
              className={`w-full flex items-start gap-3 px-4 py-3.5 border-b border-gray-50 text-left transition-colors ${
                selectedConversation?.id === conv.id ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : 'hover:bg-gray-50'
              }`}
            >
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                conv.escalated ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700'
              }`}>
                {conv.avatar}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${conv.unread ? 'text-gray-900' : 'text-gray-700'}`}>{conv.contact}</span>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">{conv.time}</span>
                </div>
                <div className="text-[11px] text-gray-400 mb-0.5">{conv.company}</div>
                <div className={`text-xs truncate ${conv.unread ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>
                  {conv.lastMessage}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <conv.channelIcon className="w-3 h-3 text-gray-400" />
                  <span className="text-[10px] text-gray-400">{conv.channel}</span>
                  {conv.aiHandled && (
                    <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                      <Sparkles className="w-2.5 h-2.5" /> AI
                    </span>
                  )}
                  {conv.escalated && (
                    <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                      <AlertTriangle className="w-2.5 h-2.5" /> Escalated
                    </span>
                  )}
                  {conv.unread && <span className="w-2 h-2 bg-indigo-500 rounded-full ml-auto" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: Conversation Detail */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {selectedConversation ? (
          <>
            {/* Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-3.5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold ${
                  selectedConversation.escalated ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700'
                }`}>
                  {selectedConversation.avatar}
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-900">{selectedConversation.contact}</div>
                  <div className="text-xs text-gray-500">{selectedConversation.company} · {selectedConversation.channel}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${confClass(selectedConversation.confidence)}`}>
                  {selectedConversation.confidence}% confidence
                </span>
                <span className="text-[11px] bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                  {selectedConversation.strategy}
                </span>
                <span className="text-[11px] bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">
                  {selectedConversation.objective}
                </span>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto px-6 py-4 flex flex-col gap-3">
              {selectedConversation.messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.sender === 'ai' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[70%] rounded-2xl px-4 py-3 ${
                    msg.sender === 'ai'
                      ? 'bg-white border border-gray-200 rounded-bl-md'
                      : 'bg-indigo-500 text-white rounded-br-md'
                  }`}>
                    <div className="text-sm leading-relaxed">{msg.text}</div>
                    <div className={`flex items-center gap-2 mt-1.5 ${msg.sender === 'ai' ? 'text-gray-400' : 'text-indigo-200'}`}>
                      <span className="text-[10px]">{msg.time}</span>
                      {msg.sender === 'ai' && (
                        <span className="text-[10px] flex items-center gap-0.5 text-indigo-400">
                          <Sparkles className="w-2.5 h-2.5" /> AI Generated
                        </span>
                      )}
                      {msg.pending && (
                        <span className="text-[10px] flex items-center gap-0.5 text-amber-500">
                          <Clock className="w-2.5 h-2.5" /> Pending approval
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* AI Action Bar */}
            <div className="bg-white border-t border-gray-200 px-6 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <span className="text-xs font-medium text-gray-700">AI Suggestion</span>
                <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">
                  {selectedConversation.confidence}% confidence
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-gray-50 rounded-lg px-4 py-2.5 text-sm text-gray-600 border border-gray-200">
                  AI is composing a response based on {selectedConversation.strategy} strategy...
                </div>
                <button className="px-4 py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-lg hover:bg-emerald-600 transition-colors flex items-center gap-1.5">
                  <CheckCheck className="w-4 h-4" /> Approve
                </button>
                <button className="px-4 py-2.5 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                  Edit
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <MessageSquare className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <div className="text-sm">Select a conversation to view</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
