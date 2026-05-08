// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge admin page (KAN-XXX)

/**
 * EditFaqDialog — pre-filled form for editing an existing FAQ entry.
 * Mirror of AddFaqDialog but PUTs to /api/knowledge/faqs/:id and seeds the
 * fields from the row passed in. Re-embeds server-side on save (sync).
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

interface FaqEntryShape {
  id: string;
  question: string;
  answer: string;
}

interface EditFaqDialogProps {
  faq: FaqEntryShape | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditFaqDialog({ faq, open, onOpenChange }: EditFaqDialogProps): React.ReactElement {
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const queryClient = useQueryClient();

  // Seed fields when the dialog opens for a new target.
  React.useEffect(() => {
    if (open && faq) {
      setQuestion(faq.question);
      setAnswer(faq.answer);
      setErrorMessage(null);
    }
  }, [open, faq]);

  const handleClose = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setErrorMessage(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const mutation = useMutation({
    mutationFn: async (input: {
      id: string;
      body: { question?: string; answer?: string };
    }): Promise<{ faq: { id: string; status: string; errorDetail: string | null } }> => {
      const res = await fetch(`${API_BASE}/api/knowledge/faqs/${input.id}`, {
        method: "PUT",
        headers: await buildHeaders(),
        body: JSON.stringify(input.body),
      });
      if (!res.ok) {
        const fallback = (await res.text()) || `HTTP ${res.status}`;
        let userMessage: string;
        switch (res.status) {
          case 400:
            userMessage = `Invalid input. ${fallback}`;
            break;
          case 404:
            userMessage = "This FAQ entry no longer exists. Refresh the list.";
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
      toast.success("FAQ entry saved.");
      handleClose(false);
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
    },
  });

  const handleSubmit = () => {
    if (!faq) return;
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
    // Send only changed fields to avoid an unnecessary re-embed when the
    // operator opens the dialog and clicks Save without editing.
    const body: { question?: string; answer?: string } = {};
    if (q !== faq.question) body.question = q;
    if (a !== faq.answer) body.answer = a;
    if (Object.keys(body).length === 0) {
      // No-op short circuit — close without server roundtrip.
      handleClose(false);
      return;
    }
    mutation.mutate({ id: faq.id, body });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit FAQ entry</DialogTitle>
          <DialogDescription>
            Save changes to update the AI&apos;s answer for this question.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-faq-question">Question</Label>
            <Textarea
              id="edit-faq-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={QUESTION_MAX}
              rows={2}
            />
            <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              {question.length} / {QUESTION_MAX.toLocaleString()}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-faq-answer">Answer</Label>
            <Textarea
              id="edit-faq-answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={ANSWER_MAX}
              rows={6}
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
            aria-label="Cancel editing FAQ entry"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!question.trim() || !answer.trim() || mutation.isPending || !faq}
            aria-label="Save FAQ entry"
          >
            {mutation.isPending ? "Saving…" : "Save FAQ entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
