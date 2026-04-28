"use client";

import { useState } from "react";
import { Globe, Upload, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { knowledgeIngestApi, type IngestRequest } from "@/lib/api";
import {
  ALLOWED_DOC_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  checkUrl,
  checkUploadedFile,
  checkQaPair,
} from "@/lib/knowledge-validation";

export function AddSourceDialog({
  open,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmitted: (ingestionId: string) => void;
}) {
  const [tab, setTab] = useState<"url" | "document" | "qa_pair">("url");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // URL state
  const [urlValue, setUrlValue] = useState("");
  // Document state
  const [file, setFile] = useState<File | null>(null);
  // Q&A state
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaAnswer, setQaAnswer] = useState("");

  function reset() {
    setUrlValue("");
    setFile(null);
    setQaQuestion("");
    setQaAnswer("");
    setError(null);
  }

  async function submit() {
    setError(null);
    let payload: IngestRequest;

    if (tab === "url") {
      const r = checkUrl(urlValue);
      if (!r.ok) {
        setError(r.reason ?? "Invalid URL");
        return;
      }
      payload = { path: "url", sourceUrl: urlValue.trim(), crawlScope: "page" };
    } else if (tab === "document") {
      if (!file) {
        setError("Please choose a file");
        return;
      }
      const r = checkUploadedFile({ name: file.name, size: file.size });
      if (!r.ok) {
        setError(r.reason ?? "Invalid file");
        return;
      }
      // V1: file upload path expects a GCS object reference. KAN-708 does NOT
      // implement the actual upload to GCS yet — that's a separate ticket
      // (KAN-735 will wire signed-URL upload). For V1 demo, the field is
      // stubbed with a placeholder ref so the request reaches the backend
      // and surfaces a clear error from the worker. Real GCS upload to land
      // alongside KAN-735.
      const stubRef = `growth-knowledge-uploads/${Date.now()}-${file.name}`;
      payload = {
        path: "document",
        uploadedFileRef: stubRef,
        originalFileName: file.name,
      };
    } else {
      const r = checkQaPair({ question: qaQuestion, answer: qaAnswer });
      if (!r.ok) {
        setError(r.reason ?? "Invalid Q&A pair");
        return;
      }
      payload = {
        path: "qa_pair",
        question: qaQuestion.trim(),
        answer: qaAnswer.trim(),
      };
    }

    setSubmitting(true);
    try {
      const result = await knowledgeIngestApi.request(payload);
      reset();
      onSubmitted(result.ingestionId);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error)?.message ?? "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add knowledge source</DialogTitle>
          <DialogDescription>
            URL crawl, document upload, or a Q&A pair. The AI uses indexed sources to ground its responses.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="url"><Globe className="h-4 w-4" /> URL</TabsTrigger>
            <TabsTrigger value="document"><Upload className="h-4 w-4" /> Document</TabsTrigger>
            <TabsTrigger value="qa_pair"><MessageSquare className="h-4 w-4" /> Q&A</TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="url">URL</Label>
              <Input
                id="url"
                placeholder="https://example.com/about"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                V1 crawls the single page. Multi-page (domain / sitemap) coming in KAN-727.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="document" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="file">File</Label>
              <Input
                id="file"
                type="file"
                accept={ALLOWED_DOC_EXTENSIONS.join(",")}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {ALLOWED_DOC_EXTENSIONS.join(", ")} · max {(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB
              </p>
            </div>
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              V1 limitation: actual file upload to Cloud Storage is not yet wired (KAN-735 follow-up). The
              request will reach the worker but parse will fail until that lands. Use Q&A or URL for now.
            </div>
          </TabsContent>

          <TabsContent value="qa_pair" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="qa-q">Question</Label>
              <Textarea
                id="qa-q"
                rows={2}
                placeholder="What's our refund policy?"
                value={qaQuestion}
                onChange={(e) => setQaQuestion(e.target.value)}
                maxLength={2000}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qa-a">Answer</Label>
              <Textarea
                id="qa-a"
                rows={5}
                placeholder="Refunds are processed within 5 business days..."
                value={qaAnswer}
                onChange={(e) => setQaAnswer(e.target.value)}
                maxLength={10000}
              />
              <p className="text-xs text-muted-foreground">
                {qaAnswer.length} / 10000 characters
              </p>
            </div>
          </TabsContent>
        </Tabs>

        {error && <div className="text-sm text-destructive">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Submitting..." : "Add source"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
