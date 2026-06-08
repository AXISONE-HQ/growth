"use client";

/**
 * KAN-742 — Lead API key management.
 *
 * Plaintext-once contract enforcement:
 *   1. The "Create new key" mutation returns the plaintext ONCE
 *   2. The modal that displays the plaintext gates dismissal on:
 *      - explicit user acknowledgment ("I've saved this key" checkbox)
 *      - at least one click on copy-to-clipboard (or skip with explicit warning)
 *   3. Server NEVER returns the plaintext again — the list endpoint only
 *      shows keyPrefix + name + lastUsedAt + revokedAt
 *
 * Revoke is IMMEDIATE: the next request after revoke fails with 401. No
 * grace period, no caching layer between revoke and the next API call.
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Copy, AlertTriangle, Trash2, CheckCircle2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { tenantApiKeysApi, type TenantApiKeySummary, type TenantApiKeyCreated } from "@/lib/api";

export default function LeadApiKeysPage() {
  const [keys, setKeys] = useState<TenantApiKeySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<TenantApiKeyCreated | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await tenantApiKeysApi.list();
      setKeys(r);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load API keys");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function create() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const r = await tenantApiKeysApi.create(newKeyName.trim());
      setCreatedKey(r);
      setNewKeyName("");
      setCreateOpen(false);
      setAcknowledged(false);
      setCopied(false);
      // Reload list (will show prefix + metadata, NOT the plaintext)
      await reload();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? It will stop working immediately. This cannot be undone — you'll need to create a new key.")) return;
    setRevokingId(id);
    try {
      await tenantApiKeysApi.revoke(id);
      await reload();
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to revoke key");
    } finally {
      setRevokingId(null);
    }
  }

  async function copyPlaintext() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.plaintext);
      setCopied(true);
    } catch {
      // clipboard API requires HTTPS or localhost — user can still select-copy manually
    }
  }

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const revokedKeys = keys?.filter((k) => k.revokedAt) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
          <Link href="/settings">
            <ArrowLeft className="h-4 w-4" />
            All settings
          </Link>
        </Button>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Lead API keys</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Authenticate against <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">POST /api/v1/leads</code> with your tenant's API keys.
              Each request becomes a Contact + emits a lead.received event.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Create key
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Error</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* ── Active keys ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active keys</CardTitle>
          <CardDescription>
            {activeKeys.length === 0
              ? "No active keys yet — click 'Create key' to generate your first one."
              : `${activeKeys.length} active ${activeKeys.length === 1 ? "key" : "keys"}.`}
          </CardDescription>
        </CardHeader>
        {activeKeys.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeKeys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-muted-foreground">axone_live_{k.keyPrefix}…</code>
                  </TableCell>
                  {/* USER-tz display: `createdAt` / `lastUsedAt` are DateTime instants
                      — operator sees key-lifecycle timestamps in their browser locale,
                      which is correct for "this happened at X" displays. KAN-943's
                      off-by-one bug applies only to `@db.Date` sources, not instants.
                      KAN-1131 PR 2 audit 2026-06-08. */}
                  <TableCell className="text-sm text-muted-foreground">{new Date(k.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : <span className="text-xs">Never</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                      onClick={() => revoke(k.id)}
                      disabled={revokingId === k.id}
                      aria-label="Revoke key"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ── Revoked keys (history) ── */}
      {revokedKeys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-muted-foreground">Revoked keys</CardTitle>
            <CardDescription>{revokedKeys.length} revoked. These keys no longer authenticate.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Revoked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revokedKeys.map((k) => (
                <TableRow key={k.id} className="text-muted-foreground">
                  <TableCell>{k.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">axone_live_{k.keyPrefix}…</code>
                  </TableCell>
                  {/* USER-tz display: `revokedAt` is a DateTime instant — same shape
                      as the active-keys table above. KAN-1131 PR 2 audit 2026-06-08. */}
                  <TableCell className="text-sm">{k.revokedAt ? new Date(k.revokedAt).toLocaleString() : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* ── Create-key dialog ── */}
      <Dialog open={createOpen} onOpenChange={(v) => { if (!creating) setCreateOpen(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give this key a recognizable name (e.g., "Webhooks integration", "Zapier"). The plaintext key
              will be shown ONCE — make sure to save it before dismissing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Production webhooks"
                maxLength={100}
                disabled={creating}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={create} disabled={creating || !newKeyName.trim()}>
                {creating ? "Creating..." : "Create key"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Plaintext-shown-once dialog (gate dismissal on acknowledgment) ── */}
      <Dialog
        open={createdKey !== null}
        onOpenChange={(v) => {
          // Block dismissal until acknowledged. The "Done" button below is
          // the only way out once shown.
          if (!v && acknowledged) {
            setCreatedKey(null);
            setAcknowledged(false);
            setCopied(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5" />
              Your new API key
            </DialogTitle>
            <DialogDescription className="text-amber-700">
              This is the only time you'll see the full key. Save it now in a secure location.
            </DialogDescription>
          </DialogHeader>
          {createdKey && (
            <div className="space-y-4 pt-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Name</Label>
                <div className="text-sm font-medium">{createdKey.name}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Plaintext key (copy now — won't be shown again)</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                    {createdKey.plaintext}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyPlaintext}>
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              <div className="rounded-[var(--ds-radius-input)] border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)] px-3 py-2 text-caption text-[var(--ds-warning-text)]">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <div>
                    <strong>This key authenticates as your tenant.</strong> Anyone with it can submit leads on
                    your behalf. Treat it like a password — store it in a secrets manager, never commit to
                    source control, never share via email or chat.
                  </div>
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="h-4 w-4"
                />
                <span className="text-sm">I've saved this key in a secure location.</span>
              </label>
              <div className="flex justify-end pt-2">
                <Button
                  onClick={() => {
                    setCreatedKey(null);
                    setAcknowledged(false);
                    setCopied(false);
                  }}
                  disabled={!acknowledged}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Done
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
