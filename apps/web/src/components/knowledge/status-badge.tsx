"use client";

import { Loader2, CheckCircle2, AlertCircle, Clock, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Status = "pending" | "processing" | "indexed" | "failed" | "stale";

const META: Record<Status, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon?: typeof Clock }> = {
  pending: { label: "Pending", variant: "secondary", icon: Clock },
  processing: { label: "Processing", variant: "secondary", icon: Loader2 },
  indexed: { label: "Indexed", variant: "default", icon: CheckCircle2 },
  failed: { label: "Failed", variant: "destructive", icon: AlertCircle },
  stale: { label: "Stale", variant: "outline", icon: RefreshCw },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = META[status];
  const Icon = m.icon;
  return (
    <Badge variant={m.variant} className="gap-1">
      {Icon && <Icon className={"h-3 w-3" + (status === "processing" ? " animate-spin" : "")} />}
      {m.label}
    </Badge>
  );
}
