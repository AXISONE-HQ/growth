"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Plus, BookOpen, Globe, Upload, MessageSquare, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/knowledge/status-badge";
import { AddSourceDialog } from "@/components/knowledge/add-source-dialog";
import { knowledgeIngestApi, type KnowledgeSourceListItem } from "@/lib/api";
import { isInProgress } from "@/lib/knowledge-validation";

type SourceTypeFilter = "all" | "url" | "document" | "qa_pair";
type SourceStatusFilter = "all" | "pending" | "processing" | "indexed" | "failed" | "stale";

const TYPE_LABEL: Record<string, { label: string; icon: typeof Globe }> = {
  url: { label: "URL", icon: Globe },
  document: { label: "Document", icon: Upload },
  qa_pair: { label: "Q&A pair", icon: MessageSquare },
  structured_field: { label: "Structured", icon: BookOpen },
};

function sourceLabel(s: KnowledgeSourceListItem): string {
  if (s.sourceUrl) return s.sourceUrl;
  if (s.originalFileName) return s.originalFileName;
  return `${s.type} · ${s.contentHash.slice(0, 8)}`;
}

export default function KnowledgeSettingsPage() {
  const [sources, setSources] = useState<KnowledgeSourceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<SourceTypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<SourceStatusFilter>("all");
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const filter: { type?: string; status?: string } = {};
      if (typeFilter !== "all") filter.type = typeFilter;
      if (statusFilter !== "all") filter.status = statusFilter;
      const rows = await knowledgeIngestApi.listSources(filter);
      setSources(rows);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load sources");
    }
  }, [typeFilter, statusFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Poll while any source is in-progress
  useEffect(() => {
    if (!sources?.some((s) => isInProgress(s.status))) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [sources, reload]);

  async function onDelete(sourceId: string) {
    if (!confirm("Delete this source and all its chunks? This cannot be undone.")) return;
    try {
      await knowledgeIngestApi.deleteSource(sourceId);
      await reload();
    } catch (e) {
      setError((e as Error)?.message ?? "Delete failed");
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge sources</h1>
          <p className="text-sm text-muted-foreground">
            URLs, documents, and Q&A pairs the AI uses to ground its responses for your business.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Add source
          </Button>
        </div>
      </header>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Couldn&apos;t load sources</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Filters */}
      {sources && sources.length > 0 && (
        <div className="flex gap-2">
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as SourceTypeFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="url">URL</SelectItem>
              <SelectItem value="document">Document</SelectItem>
              <SelectItem value="qa_pair">Q&A pair</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as SourceStatusFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="indexed">Indexed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="stale">Stale</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Loading */}
      {sources === null && !error && (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Loading sources...</CardContent></Card>
      )}

      {/* Empty state */}
      {sources && sources.length === 0 && (
        <EmptyState onAdd={() => setAddOpen(true)} />
      )}

      {/* Table */}
      {sources && sources.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[45%]">Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Chunks</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((s) => {
                const TypeIcon = TYPE_LABEL[s.type]?.icon ?? BookOpen;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-[400px]">
                      <Link href={`/settings/knowledge/${s.id}`} className="block truncate font-medium hover:underline">
                        {sourceLabel(s)}
                      </Link>
                      {s.errorMessage && (
                        <div className="mt-1 truncate text-xs text-destructive">
                          {s.errorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                        <TypeIcon className="h-3.5 w-3.5" />
                        {TYPE_LABEL[s.type]?.label ?? s.type}
                      </span>
                    </TableCell>
                    <TableCell><StatusBadge status={s.status} /></TableCell>
                    <TableCell className="text-right font-mono text-sm">{s.chunkCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/settings/knowledge/${s.id}`}>View detail</Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={() => onDelete(s.id)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <AddSourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSubmitted={() => reload()}
      />
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="rounded-full bg-muted p-3">
          <BookOpen className="h-6 w-6 text-muted-foreground" />
        </div>
        <div className="max-w-md space-y-1">
          <h3 className="text-lg font-semibold">No knowledge sources yet</h3>
          <p className="text-sm text-muted-foreground">
            Add company info, products, FAQs, or any URL or document the AI should know about your business.
            Sources are chunked, embedded, and used to ground every response.
          </p>
        </div>
        <Button onClick={onAdd} className="mt-2">
          <Plus className="h-4 w-4" />
          Add knowledge source
        </Button>
      </CardContent>
    </Card>
  );
}
