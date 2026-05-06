// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Add Source dialog FAQ flow (KAN-829), future Persona FAQ tab (KAN-831 if needed)

/**
 * FAQEditor — dynamic Q+A row editor for the FAQ source-type Add flow.
 *
 * **Contract:**
 *  - Minimum 1 entry — the last "Remove" button is disabled
 *  - Question: 1-2,000 chars
 *  - Answer: 1-10,000 chars
 *  - Per-row character counters; values clamp visually but submission
 *    validation lives in the parent dialog
 *
 * **DS v1 compliance:**
 *  - Verb + object button labels ("Add another Q+A", "Remove entry")
 *  - Sentence case throughout
 *  - Borders not shadows
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface FAQEntry {
  question: string;
  answer: string;
}

interface FAQEditorProps {
  entries: FAQEntry[];
  onChange: (entries: FAQEntry[]) => void;
}

export const QUESTION_MAX_CHARS = 2000;
export const ANSWER_MAX_CHARS = 10000;

export function FAQEditor({ entries, onChange }: FAQEditorProps): React.ReactElement {
  const addRow = React.useCallback(() => {
    onChange([...entries, { question: "", answer: "" }]);
  }, [entries, onChange]);

  const removeRow = React.useCallback(
    (idx: number) => {
      if (entries.length <= 1) return; // minimum 1 entry
      onChange(entries.filter((_, i) => i !== idx));
    },
    [entries, onChange],
  );

  const updateRow = React.useCallback(
    (idx: number, field: keyof FAQEntry, value: string) => {
      onChange(entries.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
    },
    [entries, onChange],
  );

  return (
    <div className="flex flex-col gap-4">
      {entries.map((entry, idx) => (
        <div
          key={idx}
          className="rounded-lg border p-4"
          style={{
            backgroundColor: "var(--ds-surface-base)",
            borderColor: "var(--ds-border-subtle)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-xs font-medium"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              Entry {idx + 1}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => removeRow(idx)}
              disabled={entries.length <= 1}
              aria-label={`Remove entry ${idx + 1}`}
            >
              Remove entry
            </Button>
          </div>

          <div className="flex flex-col gap-2 mb-3">
            <Label htmlFor={`faq-q-${idx}`}>Question</Label>
            <Textarea
              id={`faq-q-${idx}`}
              value={entry.question}
              onChange={(e) => updateRow(idx, "question", e.target.value)}
              maxLength={QUESTION_MAX_CHARS}
              rows={2}
              placeholder="What does the AI need to answer?"
            />
            <span
              className="text-xs"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              {entry.question.length} / {QUESTION_MAX_CHARS.toLocaleString()}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`faq-a-${idx}`}>Answer</Label>
            <Textarea
              id={`faq-a-${idx}`}
              value={entry.answer}
              onChange={(e) => updateRow(idx, "answer", e.target.value)}
              maxLength={ANSWER_MAX_CHARS}
              rows={4}
              placeholder="The answer the AI should give"
            />
            <span
              className="text-xs"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              {entry.answer.length} / {ANSWER_MAX_CHARS.toLocaleString()}
            </span>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={addRow}
        aria-label="Add another Q and A entry"
      >
        Add another Q+A
      </Button>
    </div>
  );
}
