// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * AddFaqDialog — single-screen create flow for a FAQ entry. One Q+A per
 * entry (decision 9 of the cohort brief: each FAQ entry is a discrete row,
 * which structurally resolves the multi-pair contract gap that broke
 * KAN-841).
 *
 * **Form contract:**
 *   Question — 1-2,000 chars, required
 *   Answer   — 1-10,000 chars, required
 *
 * **Server contract:** POST /api/knowledge/faqs returns the created entry
 * in its terminal status (sync embedding). On 'ready' the dialog closes
 * and the FAQ list refreshes; on 'error' the inline error panel surfaces
 * `errorDetail` so the operator can retry without having to reopen.
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens; zero hex
 *  - Sentence case + verb+object button labels ("Add FAQ entry")
 *  - Forbidden-words audit (foundation-pattern.test.ts covers this file)
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { API_BASE, buildHeaders } from "@/lib/api";

const QUESTION_MAX = 2_000;
const ANSWER_MAX = 10_000;

interface AddFaqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddFaqDialog({ open, onOpenChange }: AddFaqDialogProps): React.ReactElement {
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  const reset = React.useCallback(() => {
    setQuestion("");
    setAnswer("");
    setErrorMessage(null);
  }, []);

  const handleClose = React.useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const mutation = useMutation({
    mutationFn: async (input: { question: string; answer: string }): Promise<{ faq: { id: string; status: string; errorDetail: string | null } }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/faqs`, {
        method: "POST",
        headers: await buildHeaders(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 400:
            userMessage = `Invalid input. ${fallback}`;
            break;
          case 401:
          case 403:
            userMessage = "Sign in expired. Refresh and try again.";
            break;
          default:
            userMessage = "Something went wrong. Try again later.";
        }
        throw new Error(userMessage);
      }
      return (await res.json()) as { faq: { id: string; status: string; errorDetail: string | null } };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["knowledge", "faqs"] });
      if (result.faq.status === "error") {
        setErrorMessage(result.faq.errorDetail ?? "Embedding failed. Try again.");
        return;
      }
      toast.success("FAQ entry added.");
      handleClose(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleSubmit = () => {
    setErrorMessage(null);
    const q = question.trim();
    const a = answer.trim();
    if (!q) {
      setErrorMessage("Question is required.");
      return;
    }
    if (!a) {
      setErrorMessage("Answer is required.");
      return;
    }
    mutation.mutate({ question: q, answer: a });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add FAQ entry</DialogTitle>
          <DialogDescription>
            One question, one answer. The AI cites this directly when a customer asks something close to it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="add-faq-question">Question</Label>
            <Textarea
              id="add-faq-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={QUESTION_MAX}
              rows={2}
              placeholder="What does the AI need to answer?"
            />
            <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              {question.length} / {QUESTION_MAX.toLocaleString()}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="add-faq-answer">Answer</Label>
            <Textarea
              id="add-faq-answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={ANSWER_MAX}
              rows={6}
              placeholder="The answer the AI should give."
            />
            <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              {answer.length} / {ANSWER_MAX.toLocaleString()}
            </span>
          </div>

          {errorMessage ? (
            <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
              {errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={mutation.isPending}
            aria-label="Cancel adding FAQ entry"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!question.trim() || !answer.trim() || mutation.isPending}
            aria-label="Save FAQ entry"
          >
            {mutation.isPending ? "Saving…" : "Save FAQ entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
