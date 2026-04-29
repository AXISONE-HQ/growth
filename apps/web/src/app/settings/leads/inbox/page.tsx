"use client";

/**
 * KAN-741 — Lead Inbox settings page.
 *
 * Surfaces:
 *   - Inbox address (read-only, copy-to-clipboard)
 *   - "Regenerate inbox address" button (admin-only effect; UI shows for all)
 *   - DKIM strict-mode toggle (admin)
 *   - Recent inbox events table (deferrable to Sprint 4 per defer order in PR)
 *
 * Defer order documented in KAN-741 PR description:
 *   1. Address display + regenerate (must keep — implemented)
 *   2. DKIM toggle (must keep — implemented)
 *   3. Events table (deferrable to Sprint 4 if scope tightens — INCLUDED here)
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Copy, RefreshCw, Mail, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { inboxApi, type InboxAddressInfo, type LeadInboxEventRow } from "@/lib/api";

export default function LeadInboxSettingsPage() {
  const [info, setInfo] = useState<InboxAddressInfo | null>(null);
  const [events, setEvents] = useState<LeadInboxEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"regenerate" | "dkim" | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [i, e] = await Promise.all([
        inboxApi.getMyInboxAddress(),
        inboxApi.listRecentEvents({ limit: 50 }),
      ]);
      setInfo(i);
      setEvents(e);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to load inbox settings");
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function regenerate() {
    if (!confirm("Regenerate your inbox address? The old address will stop accepting new leads.")) return;
    setBusy("regenerate");
    try {
      const r = await inboxApi.regenerateSlug();
      setInfo((cur) => (cur ? { ...cur, slug: r.slug, address: r.address, domain: r.domain } : cur));
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to regenerate slug");
    } finally {
      setBusy(null);
    }
  }

  async function toggleDkim(next: boolean) {
    if (!info) return;
    setBusy("dkim");
    try {
      await inboxApi.setDkimStrict(next);
      setInfo({ ...info, dkimStrict: next });
    } catch (err) {
      setError((err as Error)?.message ?? "Failed to update DKIM setting");
    } finally {
      setBusy(null);
    }
  }

  async function copyAddress() {
    if (!info?.address) return;
    try {
      await navigator.clipboard.writeText(info.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API requires HTTPS or localhost — fail silently
    }
  }

  if (error && !info) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Couldn&apos;t load inbox settings</CardTitle>
            <CardDescription className="text-destructive/80">{error}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
          <Link href="/settings">
            <ArrowLeft className="h-4 w-4" />
            All settings
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Lead Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each tenant gets a unique email address. Forward or share it; every email becomes a lead with
            an audit row + a downstream action plan.
          </p>
        </div>
      </div>

      {/* ── Inbox address card ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your inbox address</CardTitle>
          <CardDescription>
            Anyone can email this address; we'll create a Contact + emit a lead.received event for each
            delivery that passes SPF/DKIM checks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {info?.address ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-sm">{info.address}</code>
              <Button variant="outline" size="sm" onClick={copyAddress}>
                <Copy className="h-4 w-4" />
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
          ) : (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              No inbox address yet — click "Regenerate" below to create one.
            </div>
          )}
          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-muted-foreground">
              Regenerating gives you a fresh slug; the old address stops accepting after the change.
            </p>
            <Button variant="outline" size="sm" onClick={regenerate} disabled={busy === "regenerate"}>
              <RefreshCw className="h-4 w-4" />
              {busy === "regenerate" ? "Regenerating..." : info?.address ? "Regenerate" : "Generate"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── DKIM strict-mode toggle ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Strict DKIM verification</CardTitle>
          <CardDescription>
            When on (default), we reject emails without a passing DKIM signature. Turn off to accept
            emails from senders on legacy mail servers without DKIM signing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Strict DKIM</div>
                <p className="text-xs text-muted-foreground">
                  {info?.dkimStrict
                    ? "Currently strict — emails without a passing DKIM signature are rejected"
                    : "Currently lenient — emails accepted as long as DKIM is not a hard fail"}
                </p>
              </div>
            </div>
            <Switch
              checked={info?.dkimStrict ?? true}
              onCheckedChange={(v) => toggleDkim(v)}
              disabled={busy === "dkim" || !info}
            />
          </div>
        </CardContent>
      </Card>

      {error && info && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* ── Recent events table ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>
            Last 50 emails delivered to your inbox address. Rejected emails show up here too with the
            reason — useful for diagnosing failed deliveries.
          </CardDescription>
        </CardHeader>
        {!events || events.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <Mail className="mx-auto mb-2 h-6 w-6 opacity-50" />
            No inbox events yet. Forward an email to your address above to see it appear here.
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="max-w-[200px] truncate text-sm">{e.fromAddress}</TableCell>
                  <TableCell className="max-w-[300px] truncate text-sm">
                    {e.subject ?? <span className="text-muted-foreground">(no subject)</span>}
                  </TableCell>
                  <TableCell>
                    <StatusCell status={e.status} reason={e.rejectionReason} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function StatusCell({ status, reason }: { status: LeadInboxEventRow["status"]; reason: string | null }) {
  if (status === "accepted") {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Accepted
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-sm text-amber-700"
      title={reason ?? undefined}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {status.replace(/_/g, " ")}
    </span>
  );
}
