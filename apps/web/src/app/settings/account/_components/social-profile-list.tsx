"use client";

/**
 * KAN-855 — Social profile list (add row pattern + remove icon button).
 *
 * Per spec §7.2 + §8 empty-state copy: "No social profiles added. AI
 * cites these when contacts ask how to follow you."
 *
 * Add row: platform select + URL input + add button. URL must start
 * with `https://` (server enforces; we mirror client-side for fast
 * feedback). Server auto-positions at end + 1.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpcMutation } from "@/lib/api";
import { toast } from "sonner";
import { X } from "lucide-react";

const PLATFORMS = [
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "twitter", label: "X (Twitter)" },
  { value: "youtube", label: "YouTube" },
  { value: "tiktok", label: "TikTok" },
  { value: "other", label: "Other" },
] as const;

export interface SocialProfileRow {
  id: string;
  platform: string;
  url: string;
  handle: string | null;
  position: number;
}

interface SocialProfileListProps {
  profiles: SocialProfileRow[];
  /** Called after a successful add or remove so the parent re-fetches. */
  onChange: () => void | Promise<void>;
}

export function SocialProfileList({
  profiles,
  onChange,
}: SocialProfileListProps): React.ReactElement {
  const [platform, setPlatform] = React.useState<(typeof PLATFORMS)[number]["value"]>("linkedin");
  const [url, setUrl] = React.useState("");
  const [isAdding, setIsAdding] = React.useState(false);
  const [pendingRemoveId, setPendingRemoveId] = React.useState<string | null>(null);
  const [addError, setAddError] = React.useState<string | null>(null);

  async function handleAdd(): Promise<void> {
    setAddError(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setAddError("URL is required.");
      return;
    }
    if (!trimmed.startsWith("https://")) {
      setAddError("URL must start with https://");
      return;
    }
    setIsAdding(true);
    try {
      await trpcMutation("account.addSocialProfile", { platform, url: trimmed });
      setUrl("");
      await onChange();
      toast.success("Social profile added.");
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
      await trpcMutation("account.removeSocialProfile", { id });
      await onChange();
      toast.success("Social profile removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Remove failed. Try again.";
      toast.error(message);
    } finally {
      setPendingRemoveId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {profiles.length === 0 ? (
        <p
          className="text-sm py-4 px-3 rounded-md"
          style={{
            color: "var(--ds-ink-tertiary)",
            backgroundColor: "var(--ds-surface-sunken)",
          }}
        >
          No social profiles added. AI cites these when contacts ask how to follow you.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Social profiles">
          {profiles.map((p) => {
            const platformLabel = PLATFORMS.find((pl) => pl.value === p.platform)?.label ?? p.platform;
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 p-3 rounded-md border"
                style={{ borderColor: "var(--ds-border-subtle)" }}
              >
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded"
                  style={{
                    backgroundColor: "var(--ds-surface-sunken)",
                    color: "var(--ds-ink-secondary)",
                  }}
                >
                  {platformLabel}
                </span>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm flex-1 truncate hover:underline focus-visible:underline focus-visible:outline-none"
                  style={{ color: "var(--ds-ink-primary)" }}
                >
                  {p.handle ?? p.url}
                </a>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingRemoveId === p.id}
                  onClick={() => void handleRemove(p.id)}
                  aria-label={`Remove ${platformLabel} profile`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 pt-2">
        <div
          className="flex items-end gap-2 pt-3"
          style={{ borderTop: "1px solid var(--ds-border-subtle)" }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="social-platform">Platform</Label>
            <select
              id="social-platform"
              value={platform}
              onChange={(e) =>
                setPlatform(e.target.value as (typeof PLATFORMS)[number]["value"])
              }
              className="h-10 rounded-md border px-3 text-sm motion-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
              style={{
                backgroundColor: "var(--ds-surface-base)",
                borderColor: "var(--ds-border-default)",
                color: "var(--ds-ink-primary)",
              }}
            >
              {PLATFORMS.map((pl) => (
                <option key={pl.value} value={pl.value}>
                  {pl.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="social-url">URL</Label>
            <Input
              id="social-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://linkedin.com/in/your-handle"
              disabled={isAdding}
            />
          </div>
          <Button
            type="button"
            disabled={isAdding || !url.trim()}
            onClick={() => void handleAdd()}
            aria-label="Add social profile"
          >
            {isAdding ? "Adding…" : "Add social profile"}
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
