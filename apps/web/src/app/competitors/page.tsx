'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Loader2, AlertTriangle, CheckCircle } from 'lucide-react';
import {
  competitorsApi,
  type Competitor,
  type CompetitorBattleCard,
  type CompetitorNews,
} from '@/lib/api';

/* ── Toast ─────────────────────────────────────────────── */
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
      type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
    }`}>
      {type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {message}
    </div>
  );
}

/* ── Style maps ────────────────────────────────────────── */
const statusCls: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  inactive: 'bg-gray-100 text-gray-600',
  archived: 'bg-red-100 text-red-800',
};
const sentCls: Record<string, string> = { positive: 'text-green-600', negative: 'text-red-600', neutral: 'text-gray-500' };
const sentDot: Record<string, string> = { positive: 'bg-green-400', negative: 'bg-red-400', neutral: 'bg-gray-400' };

/* ── Detail Panel ──────────────────────────────────────── */
function Panel({
  competitor,
  onClose,
}: {
  competitor: Competitor;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'bc' | 'news'>('bc');
  const [battleCard, setBattleCard] = useState<CompetitorBattleCard | null>(null);
  const [news, setNews] = useState<CompetitorNews[]>([]);
  const [loadingBc, setLoadingBc] = useState(true);
  const [loadingNews, setLoadingNews] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingBc(true);
      setLoadingNews(true);
      try {
        const [bc, newsRes] = await Promise.all([
          competitorsApi.getBattleCard(competitor.id),
          competitorsApi.listNews({ competitorId: competitor.id, limit: 20 }),
        ]);
        if (!cancelled) {
          setBattleCard(bc);
          setNews(newsRes.news);
        }
      } catch (e) {
        console.error('Failed to load competitor details:', e);
      } finally {
        if (!cancelled) {
          setLoadingBc(false);
          setLoadingNews(false);
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [competitor.id]);

  const Section = ({ title, color, items }: { title: string; color: string; items: string[] }) => (
    <section className="mb-4">
      <h3 className={`text-sm font-semibold ${color} mb-2`}>{title}</h3>
      <ul className="space-y-1">
        {items.map((s, i) => <li key={i} className="text-sm text-gray-600 pl-4">&bull; {s}</li>)}
      </ul>
    </section>
  );

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-lg bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{competitor.name}</h2>
            <p className="text-sm text-gray-500">{competitor.description}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="px-6 py-3 border-b flex gap-1">
          <button onClick={() => setTab('bc')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'bc' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}>
            Battle Card
          </button>
          <button onClick={() => setTab('news')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'news' ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'}`}>
            News ({news.length})
          </button>
        </div>

        <div className="px-6 py-5">
          {tab === 'bc' && (
            loadingBc ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
              </div>
            ) : battleCard ? (
              <div>
                <section className="mb-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">Overview</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{battleCard.overview}</p>
                </section>
                <Section title="Strengths" color="text-green-700" items={battleCard.strengths} />
                <Section title="Weaknesses" color="text-red-700" items={battleCard.weaknesses} />
                <Section title="Our Differentiators" color="text-blue-700" items={battleCard.differentiators} />
                <section className="mb-4">
                  <h3 className="text-sm font-semibold text-amber-700 mb-2">Common Objections</h3>
                  {battleCard.objections.map((o, i) => (
                    <div key={i} className="bg-amber-50 rounded-lg p-3 text-sm text-amber-900 border border-amber-100 mb-2">
                      &ldquo;{o}&rdquo;
                    </div>
                  ))}
                </section>
                <Section title="Talking Points" color="text-purple-700" items={battleCard.talkingPoints} />
                <div className="text-xs text-gray-400 pt-2 border-t">
                  Version {battleCard.version} &middot; Updated {new Date(battleCard.generatedAt).toLocaleDateString()}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No battle card available.</p>
            )
          )}

          {tab === 'news' && (
            loadingNews ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
              </div>
            ) : (
              <div className="space-y-3">
                {news.length === 0 ? (
                  <p className="text-sm text-gray-500">No news items.</p>
                ) : (
                  news.map((n) => (
                    <div key={n.id} className="border rounded-lg p-4 hover:bg-gray-50">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h4 className="text-sm font-medium text-gray-900">{n.title}</h4>
                        <span className={`text-xs font-medium whitespace-nowrap ${sentCls[n.sentiment]}`}>
                          <span className={`inline-block w-2 h-2 rounded-full mr-1 ${sentDot[n.sentiment]}`} />
                          {n.sentiment}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mb-2">{n.summary}</p>
                      <div className="flex gap-3 text-xs text-gray-400">
                        {n.publishedAt && <span>{new Date(n.publishedAt).toLocaleDateString()}</span>}
                        {n.sourceUrl && (
                          <a href={n.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                            Source
                          </a>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────── */
export default function CompetitorsPage() {
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  // ── Data state ──
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [totalCompetitors, setTotalCompetitors] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [totalNews, setTotalNews] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Competitor | null>(null);

  // ── Search & filter ──
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // ── Load competitors ──
  const loadCompetitors = useCallback(async () => {
    try {
      const params: { page: number; limit: number; search?: string; status?: string } = {
        page,
        limit: 50,
      };
      if (search) params.search = search;
      if (statusFilter !== 'all') params.status = statusFilter;

      const res = await competitorsApi.list(params);
      setCompetitors(res.competitors);
      setTotalCompetitors(res.pagination.total);
    } catch (e) {
      console.error('Failed to load competitors:', e);
      showToast('Failed to load competitors', 'error');
    }
  }, [page, search, statusFilter]);

  const loadStats = useCallback(async () => {
    try {
      const stats = await competitorsApi.getStats();
      setActiveCount(stats.activeCompetitors);
      setTotalNews(stats.totalNews);
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }, []);

  // Initial load
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      await Promise.all([loadCompetitors(), loadStats()]);
      setLoading(false);
    };
    loadAll();
  }, [loadCompetitors, loadStats]);

  // Re-fetch when search/filter changes (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      loadCompetitors();
    }, 300);
    return () => clearTimeout(timer);
  }, [search, statusFilter, loadCompetitors]);

  /* ── Loading Screen ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading Competitor Intelligence...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Competitor Intelligence</h1>
          <p className="text-gray-500 mt-1">Track and analyze your competitive landscape with AI-powered insights.</p>
        </div>

        {/* ── Stats Cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {[
            ['Total Competitors', totalCompetitors, 'text-gray-900', 'bg-blue-50'],
            ['Active Tracking', activeCount, 'text-green-600', 'bg-green-50'],
            ['News Items', totalNews, 'text-purple-600', 'bg-purple-50'],
          ].map(([label, val, tc]) => (
            <div key={String(label)} className="bg-white rounded-xl shadow-sm border p-5">
              <p className="text-sm text-gray-500">{String(label)}</p>
              <p className={`text-3xl font-bold mt-1 ${tc}`}>{String(val)}</p>
            </div>
          ))}
        </div>

        {/* ── Search & Filter ── */}
        <div className="bg-white rounded-xl shadow-sm border p-4 mb-6 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              <circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" />
            </svg>
            <input
              type="text"
              placeholder="Search competitors..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {/* ── Competitors Table ── */}
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3">Competitor</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3">Status</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden md:table-cell">Description</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden lg:table-cell">Battle Card</th>
                <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden lg:table-cell">News</th>
                <th className="text-right text-xs font-semibold text-gray-500 uppercase px-6 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {competitors.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-500 text-sm">
                    {search || statusFilter !== 'all'
                      ? 'No competitors match your search.'
                      : 'No competitors added yet.'}
                  </td>
                </tr>
              ) : (
                competitors.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(c)}>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {c.name.charAt(0)}
                        </div>
                        <div>
                          <div className="font-medium text-gray-900 text-sm">{c.name}</div>
                          {c.website && <div className="text-xs text-gray-400">{c.website.replace('https://', '')}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusCls[c.status]}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell">
                      <span className="text-sm text-gray-600">{c.description || '—'}</span>
                    </td>
                    <td className="px-6 py-4 hidden lg:table-cell">
                      <span className={`text-sm ${c.battleCards && c.battleCards.length ? 'text-green-600' : 'text-gray-400'}`}>
                        {c.battleCards && c.battleCards.length ? 'Available' : 'None'}
                      </span>
                    </td>
                    <td className="px-6 py-4 hidden lg:table-cell">
                      <span className="text-sm text-gray-600">
                        {c._count?.news ?? 0} item{(c._count?.news ?? 0) !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelected(c); }}
                        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="px-6 py-3 border-t bg-gray-50 text-xs text-gray-500">
            Showing {competitors.length} of {totalCompetitors} competitors
          </div>
        </div>
      </div>

      {selected && <Panel competitor={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
