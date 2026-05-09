"use client";

/**
 * KAN-859 — IndustryDisclosureList. Mirrors the SocialProfileList /
 * HolidayList inline-add-row pattern from Cohorts 2/3.
 *
 * Add row: label Input + body Textarea + 3 channel checkboxes (Email,
 * SMS, WhatsApp) per the `appliesToChannels` enum in DisclosureCreateSchema.
 * Existing rows: label, body preview (truncated), channels badge, remove.
 *
 * Empty state copy from spec §8: "No disclosures added. Required for
 * regulated industries."
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpcMutation } from "@/lib/api";
import { toast } from "sonner";
import { X } from "lucide-react";

export type DisclosureChannel = "email" | "sms" | "whatsapp";

export interface DisclosureRow {
  id: string;
  label: string;
  body: string;
  appliesToChannels: readonly DisclosureChannel[];
  position: number;
}

const CHANNEL_OPTIONS: ReadonlyArray<{ value: DisclosureChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
];

const BODY_PREVIEW_LIMIT = 120;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

interface IndustryDisclosureListProps {
  disclosures: DisclosureRow[];
  onChange: () => void | Promise<void>;
}

export function IndustryDisclosureList({
  disclosures,
  onChange,
}: IndustryDisclosureListProps): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [body, setBody] = React.useState("");
  const [channels, setChannels] = React.useState<DisclosureChannel[]>([]);
  const [isAdding, setIsAdding] = React.useState(false);
  const [pendingRemoveId, setPendingRemoveId] = React.useState<string | null>(null);
  const [addError, setAddError] = React.useState<string | null>(null);

  function toggleChannel(c: DisclosureChannel): void {
    if (channels.includes(c)) {
      setChannels(channels.filter((x) => x !== c));
    } else {
      setChannels([...channels, c]);
    }
  }

  async function handleAdd(): Promise<void> {
    setAddError(null);
    if (!label.trim()) {
      setAddError("Label is required.");
      return;
    }
    if (!body.trim()) {
      setAddError("Body is required.");
      return;
    }
    setIsAdding(true);
    try {
      await trpcMutation("account.addDisclosure", {
        label: label.trim(),
        body: body.trim(),
        appliesToChannels: channels,
      });
      setLabel("");
      setBody("");
      setChannels([]);
      await onChange();
      toast.success("Disclosure added.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Add failed. Try again.";
      setAddError(message);
      toast.error(message);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setPendingRemoveId(id);
    try {
      await trpcMutation("account.removeDisclosure", { id });
      await onChange();
      toast.success("Disclosure removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Remove failed. Try again.";
      toast.error(message);
    } finally {
      setPendingRemoveId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {disclosures.length === 0 ? (
        <p
          className="text-sm py-4 px-3 rounded-md"
          style={{
            color: "var(--ds-ink-tertiary)",
            backgroundColor: "var(--ds-surface-sunken)",
          }}
        >
          No disclosures added. Required for regulated industries.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Industry disclosures">
          {disclosures.map((d) => (
            <li
              key={d.id}
              className="flex items-start gap-3 p-3 rounded-md border"
              style={{ borderColor: "var(--ds-border-subtle)" }}
            >
              <div className="flex flex-col gap-1 flex-1">
                <span
                  className="text-sm font-medium"
                  style={{ color: "var(--ds-ink-primary)" }}
                >
                  {d.label}
                </span>
                <span
                  className="text-xs"
                  style={{ color: "var(--ds-ink-secondary)" }}
                >
                  {truncate(d.body, BODY_PREVIEW_LIMIT)}
                </span>
                {d.appliesToChannels.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {d.appliesToChannels.map((c) => (
                      <span
                        key={c}
                        className="text-xs font-medium px-2 py-0.5 rounded"
                        style={{
                          backgroundColor: "var(--ds-surface-sunken)",
                          color: "var(--ds-ink-secondary)",
                        }}
                      >
                        {CHANNEL_OPTIONS.find((o) => o.value === c)?.label ?? c}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pendingRemoveId === d.id}
                onClick={() => void handleRemove(d.id)}
                aria-label={`Remove disclosure: ${d.label}`}
              >
                <X className="w-4 h-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="flex flex-col gap-3 pt-3"
        style={{ borderTop: "1px solid var(--ds-border-subtle)" }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="disclosure-label">Disclosure label</Label>
          <Input
            id="disclosure-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
            disabled={isAdding}
            placeholder="e.g., FINRA disclosure"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="disclosure-body">Body</Label>
          <Textarea
            id="disclosure-body"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={isAdding}
            placeholder="The full disclosure text customers will see."
          />
        </div>
        <fieldset
          aria-label="Applies to channels"
          className="flex flex-col gap-1.5 m-0 p-0 border-0"
        >
          <legend className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            Applies to
          </legend>
          <div className="flex flex-wrap gap-3">
            {CHANNEL_OPTIONS.map((opt) => {
              const id = `disclosure-channel-${opt.value}`;
              const checked = channels.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  htmlFor={id}
                  className="flex items-center gap-2 cursor-pointer text-sm"
                >
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    disabled={isAdding}
                    onChange={() => toggleChannel(opt.value)}
                    className="h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
                  />
                  <span style={{ color: "var(--ds-ink-primary)" }}>{opt.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={isAdding || !label.trim() || !body.trim()}
            onClick={() => void handleAdd()}
            aria-label="Add disclosure"
          >
            {isAdding ? "Adding…" : "Add disclosure"}
          </Button>
        </div>
        {addError ? (
          <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
            {addError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
