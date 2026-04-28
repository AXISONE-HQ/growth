"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2, Globe, Upload, MessageSquare, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/knowledge/status-badge";
import { knowledgeIngestApi, type KnowledgeSourceDetail } from "@/lib/api";
import { isInProgress } from "@growth/shared";

const TYPE_LABEL: Record<string, { label: string; icon: typeof Globe }> = {
  url: { label: "URL", icon: Globe },
  document: { label: "Document", icon: Upload },
  qa_pair: { label: "Q&A pair", icon: MessageSquare },
  structured_field: { label: "Structured", icon: BookOpen },
};

export default function KnowledgeSourceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [source, setSource] = useState<KnowledgeSourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!params?.id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const r = await knowledgeIngestApi.getSourceById(params.id);
        if (!cancelled) {
          setSource(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message ?? "Failed to load source");
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [params?.id]);

  // Poll while in-progress
  useEffect(() => {
    if (!source || !isInProgress(source.status)) return;
    const t = setInterval(async () => {
      try {
        const r = await knowledgeIngestApi.getSourceById(source.id);
        setSource(r);
      } catch {
        // swallow polling errors; load() handler will surface persistent ones
      }
    }, 5000);
    return () => clearInterval(t);
  }, [source]);

  async function onDelete() {
    if (!source) return;
    if (!confirm(`Delete this source and all ${source.totalChunks} chunks? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await knowledgeIngestApi.deleteSource(source.id);
      router.push("/settings/knowledge");
    } catch (e) {
      setError((e as Error)?.message ?? "Delete failed");
      setDeleting(false);
    }
  }

  function toggleChunk(id: string) {
    setExpandedChunks((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Couldn&apos;t load source</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }
  if (!source) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const TypeIcon = TYPE_LABEL[source.type]?.icon ?? BookOpen;
  const sourceLabel = source.sourceUrl ?? source.originalFileName ?? `${source.type} · ${source.contentHash.slice(0, 8)}`;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
          <Link href="/settings/knowledge">
            <ArrowLeft className="h-4 w-4" />
            All sources
          </Link>
        </Button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="break-all text-2xl font-semibold tracking-tight">{sourceLabel}</h1>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <TypeIcon className="h-3.5 w-3.5" />
                {TYPE_LABEL[source.type]?.label ?? source.type}
              </span>
              <StatusBadge status={source.status} />
              {source.lastIndexedAt && (
                <span className="text-sm text-muted-foreground">
                  Last indexed {new Date(source.lastIndexedAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>

      {source.errorMessage && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Ingestion error</CardTitle>
            <CardDescription className="text-destructive/80">{source.errorMessage}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Chunks</CardTitle>
          <CardDescription>
            {source.totalChunks === 0
              ? "No chunks yet — content is still being processed or failed."
              : `${source.totalChunks} chunk${source.totalChunks === 1 ? "" : "s"} indexed.${source.totalChunks > source.chunks.length ? ` Showing first ${source.chunks.length}.` : ""}`}
          </CardDescription>
        </CardHeader>
        {source.chunks.length > 0 && (
          <CardContent className="space-y-2">
            {source.chunks.map((c) => {
              const expanded = expandedChunks.has(c.id);
              const preview = expanded ? c.content : c.content.slice(0, 200);
              return (
                <div key={c.id} className="rounded-md border p-3">
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Chunk {c.chunkIndex + 1} of {c.totalChunks} · {c.tokenCount} tokens · {c.embeddingModel}
                    </span>
                    {c.content.length > 200 && (
                      <button
                        type="button"
                        onClick={() => toggleChunk(c.id)}
                        className="text-primary hover:underline"
                      >
                        {expanded ? "Collapse" : "Expand"}
                      </button>
                    )}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">{preview}{!expanded && c.content.length > 200 ? "..." : ""}</pre>
                </div>
              );
            })}
          </CardContent>
        )}
      </Card>

      {source.recentIngestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent ingestion attempts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {source.recentIngestions.map((i) => (
              <div key={i.ingestionId} className="flex items-center justify-between">
                <code className="font-mono text-xs text-muted-foreground">{i.ingestionId.slice(0, 8)}…</code>
                <StatusBadge status={i.status as never} />
                <span className="text-xs text-muted-foreground">
                  {new Date(i.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Separator />
      <p className="text-xs text-muted-foreground">
        Source ID: <code className="font-mono">{source.id}</code>
      </p>
    </div>
  );
}
