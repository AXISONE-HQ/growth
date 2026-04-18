"use client";
import { useState, useMemo } from "react";

interface Competitor {
  id: string; name: string; website: string | null; description: string | null;
  status: "active" | "inactive" | "archived"; battleCards: BattleCard[]; news: CNews[];
}
interface BattleCard {
  id: string; overview: string; strengths: string[]; weaknesses: string[];
  differentiators: string[]; objections: string[]; talkingPoints: string[];
  version: number; updatedAt: string;
}
interface CNews {
  id: string; title: string; summary: string; sourceUrl: string | null;
  publishedAt: string | null; sentiment: "positive" | "negative" | "neutral";
}

const COMP_DATA = [
  ["HubSpot","hubspot.com","Inbound marketing, sales, and CRM platform"],
  ["Salesforce","salesforce.com","Enterprise CRM and sales automation"],
  ["Outreach","outreach.io","Sales engagement platform"],
  ["Apollo.io","apollo.io","Sales intelligence and engagement"],
  ["Gong","gong.io","Revenue intelligence platform"],
  ["Drift","drift.com","Conversational marketing and sales"],
  ["Clari","clari.com","Revenue operations platform"],
  ["Salesloft","salesloft.com","Sales engagement and analytics"],
  ["6sense","6sense.com","ABM and predictive intelligence"],
  ["ZoomInfo","zoominfo.com","B2B contact and company data"],
] as const;

const COMPETITORS: Competitor[] = COMP_DATA.map(([name, domain, desc], i) => ({
  id: String(i + 1), name, website: `https://${domain}`, description: desc, status: "active",
  battleCards: [{
    id: `b${i}`,
    overview: `${name} is a key competitor with strong brand recognition but higher costs and slower innovation compared to growth.`,
    strengths: ["Market leader", "Brand recognition", "Large ecosystem"],
    weaknesses: ["Complex pricing", "Slow innovation", "High cost"],
    differentiators: ["AI-native approach", "Unified loop architecture"],
    objections: [`We already use ${name}`, "Migration concerns"],
    talkingPoints: ["Faster time to value", "Lower TCO", "AI-driven decisions"],
    version: 1, updatedAt: new Date().toISOString(),
  }],
  news: [{
    id: `n${i}`, title: `${name} announces Q1 2026 results`,
    summary: `${name} reported growth in enterprise segment with new AI features.`,
    sourceUrl: `https://example.com/news/${domain.split(".")[0]}`,
    publishedAt: new Date().toISOString(), sentiment: "neutral",
  }],
}));

const statusCls: Record<string, string> = {
  active: "bg-green-100 text-green-800", inactive: "bg-gray-100 text-gray-600", archived: "bg-red-100 text-red-800",
};
const sentCls: Record<string, string> = { positive: "text-green-600", negative: "text-red-600", neutral: "text-gray-500" };
const sentDot: Record<string, string> = { positive: "bg-green-400", negative: "bg-red-400", neutral: "bg-gray-400" };

function Panel({ c, onClose }: { c: Competitor; onClose: () => void }) {
  const [tab, setTab] = useState<"bc" | "news">("bc");
  const bc = c.battleCards[0];
  const Section = ({ title, color, items }: { title: string; color: string; items: string[] }) => (
    <section className="mb-4">
      <h3 className={`text-sm font-semibold ${color} mb-2`}>{title}</h3>
      <ul className="space-y-1">{items.map((s, i) => <li key={i} className="text-sm text-gray-600 pl-4">&bull; {s}</li>)}</ul>
    </section>
  );
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-lg bg-white shadow-2xl overflow-y-auto">
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between z-10">
          <div><h2 className="text-lg font-bold text-gray-900">{c.name}</h2><p className="text-sm text-gray-500">{c.description}</p></div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="px-6 py-3 border-b flex gap-1">
          <button onClick={() => setTab("bc")} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "bc" ? "bg-blue-50 text-blue-700" : "text-gray-500 hover:bg-gray-50"}`}>Battle Card</button>
          <button onClick={() => setTab("news")} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === "news" ? "bg-blue-50 text-blue-700" : "text-gray-500 hover:bg-gray-50"}`}>News ({c.news.length})</button>
        </div>
        <div className="px-6 py-5">
          {tab === "bc" && bc ? (<div>
            <section className="mb-4"><h3 className="text-sm font-semibold text-gray-900 mb-2">Overview</h3><p className="text-sm text-gray-600 leading-relaxed">{bc.overview}</p></section>
            <Section title="Strengths" color="text-green-700" items={bc.strengths} />
            <Section title="Weaknesses" color="text-red-700" items={bc.weaknesses} />
            <Section title="Our Differentiators" color="text-blue-700" items={bc.differentiators} />
            <section className="mb-4">
              <h3 className="text-sm font-semibold text-amber-700 mb-2">Common Objections</h3>
              {bc.objections.map((o, i) => <div key={i} className="bg-amber-50 rounded-lg p-3 text-sm text-amber-900 border border-amber-100 mb-2">&ldquo;{o}&rdquo;</div>)}
            </section>
            <Section title="Talking Points" color="text-purple-700" items={bc.talkingPoints} />
            <div className="text-xs text-gray-400 pt-2 border-t">Version {bc.version} &middot; Updated {new Date(bc.updatedAt).toLocaleDateString()}</div>
          </div>) : tab === "bc" ? <p className="text-sm text-gray-500">No battle card available.</p> : (
            <div className="space-y-3">{c.news.length === 0 ? <p className="text-sm text-gray-500">No news items.</p> : c.news.map((n) => (
              <div key={n.id} className="border rounded-lg p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h4 className="text-sm font-medium text-gray-900">{n.title}</h4>
                  <span className={`text-xs font-medium whitespace-nowrap ${sentCls[n.sentiment]}`}><span className={`inline-block w-2 h-2 rounded-full mr-1 ${sentDot[n.sentiment]}`} />{n.sentiment}</span>
                </div>
                <p className="text-sm text-gray-600 mb-2">{n.summary}</p>
                <div className="flex gap-3 text-xs text-gray-400">
                  {n.publishedAt && <span>{new Date(n.publishedAt).toLocaleDateString()}</span>}
                  {n.sourceUrl && <a href={n.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">Source</a>}
                </div>
              </div>
            ))}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CompetitorsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState<Competitor | null>(null);
  const filtered = useMemo(() => COMPETITORS.filter((c) => {
    const ms = !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.description || "").toLowerCase().includes(search.toLowerCase());
    const mf = statusFilter === "all" || c.status === statusFilter;
    return ms && mf;
  }), [search, statusFilter]);
  const totalNews = COMPETITORS.reduce((s, c) => s + c.news.length, 0);
  const activeCount = COMPETITORS.filter((c) => c.status === "active").length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Competitor Intelligence</h1>
          <p className="text-gray-500 mt-1">Track and analyze your competitive landscape with AI-powered insights.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {[["Total Competitors", COMPETITORS.length, "text-gray-900", "bg-blue-50"], ["Active Tracking", activeCount, "text-green-600", "bg-green-50"], ["News Items", totalNews, "text-purple-600", "bg-purple-50"]].map(([label, val, tc, bg]) => (
            <div key={String(label)} className="bg-white rounded-xl shadow-sm border p-5">
              <p className="text-sm text-gray-500">{String(label)}</p>
              <p className={`text-3xl font-bold mt-1 ${tc}`}>{String(val)}</p>
            </div>
          ))}
        </div>
        <div className="bg-white rounded-xl shadow-sm border p-4 mb-6 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></svg>
            <input type="text" placeholder="Search competitors..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
            <option value="all">All Statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
          </select>
        </div>
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b bg-gray-50">
              <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3">Competitor</th>
              <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3">Status</th>
              <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden md:table-cell">Description</th>
              <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden lg:table-cell">Battle Card</th>
              <th className="text-left text-xs font-semibold text-gray-500 uppercase px-6 py-3 hidden lg:table-cell">News</th>
              <th className="text-right text-xs font-semibold text-gray-500 uppercase px-6 py-3">Action</th>
            </tr></thead>
            <tbody className="divide-y">
              {filtered.length === 0 ? <tr><td colSpan={6} className="px-6 py-12 text-center text-gray-500 text-sm">No competitors match your search.</td></tr> : filtered.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(c)}>
                  <td className="px-6 py-4"><div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0">{c.name.charAt(0)}</div>
                    <div><div className="font-medium text-gray-900 text-sm">{c.name}</div>{c.website && <div className="text-xs text-gray-400">{c.website.replace("https://","")}</div>}</div>
                  </div></td>
                  <td className="px-6 py-4"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusCls[c.status]}`}>{c.status}</span></td>
                  <td className="px-6 py-4 hidden md:table-cell"><span className="text-sm text-gray-600">{c.description || "\u2014"}</span></td>
                  <td className="px-6 py-4 hidden lg:table-cell"><span className={`text-sm ${c.battleCards.length ? "text-green-600" : "text-gray-400"}`}>{c.battleCards.length ? "Available" : "None"}</span></td>
                  <td className="px-6 py-4 hidden lg:table-cell"><span className="text-sm text-gray-600">{c.news.length} item{c.news.length !== 1 ? "s" : ""}</span></td>
                  <td className="px-6 py-4 text-right"><button onClick={(e) => { e.stopPropagation(); setSelected(c); }} className="text-sm text-blue-600 hover:text-blue-800 font-medium">View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-6 py-3 border-t bg-gray-50 text-xs text-gray-500">Showing {filtered.length} of {COMPETITORS.length} competitors</div>
        </div>
      </div>
      {selected && <Panel c={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
