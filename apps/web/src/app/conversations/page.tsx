'use client';

/**
 * KAN-718 — /conversations is a demo-only route until the unified-inbox
 * backend ships in a future sprint. The page renders mock data when
 * `isDemoMode()` is true; outside demo mode it shows a "coming soon" empty
 * state. Sidebar nav hides this route entirely when demo mode is off.
 *
 * Mock content lives in `./demo-fixtures.ts` — keeps module-scope of this
 * file free of mock data so the May 6 drift-sweep classifier doesn't
 * false-positive. Importing from a `*demo-fixtures*` file is one of the
 * canonical demo-gating patterns (per `apps/web/src/lib/demo-mode.ts`).
 *
 * Removed the broken `conversationsApi` import (pre-KAN-689 cohort, 1 of
 * the 4 broken-imports errors KAN-718 retires).
 */

import {
  MessageSquare, Search, Filter, Clock, Mail, Phone, MessageCircle,
  Send, ChevronDown, MoreHorizontal, Paperclip, Sparkles, User,
  ArrowUpRight, CheckCheck, AlertTriangle, Zap, Star, Archive
} from 'lucide-react';
import { useState } from 'react';
import { isDemoMode } from '@/lib/demo-mode';
import { demoConversations } from './demo-fixtures';


const channelFilters = ['All', 'Email', 'SMS', 'WhatsApp'];
const statusFilters = ['All', 'AI Handled', 'Escalated', 'Unread'];

/* ─── Component ─────────────────────────────────────── */
export default function ConversationsPage() {
  // Hooks must always run, regardless of demo-mode gate (Rules of Hooks).
  const [selectedConversation, setSelectedConversation] = useState(demoConversations[0]);
  const [channelFilter, setChannelFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  // KAN-718: outside demo mode, render a polite "coming soon" empty state.
  // The unified-inbox backend isn't a V1 deliverable; sales demos still get
  // the mock UI when NEXT_PUBLIC_DEMO_MODE=true.
  if (!isDemoMode()) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-3xl mx-auto px-6 py-16 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
            <MessageSquare className="w-6 h-6 text-gray-400" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            Conversations — coming soon
          </h1>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            The unified inbox for AI-handled conversations across email, SMS,
            and WhatsApp will land in a future release. Until then, individual
            channel histories are visible from each contact's detail view.
          </p>
        </div>
      </div>
    );
  }

  const activeConversations = demoConversations;

  const filtered = activeConversations.filter((c) => {
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
              {activeConversations.length} active
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
