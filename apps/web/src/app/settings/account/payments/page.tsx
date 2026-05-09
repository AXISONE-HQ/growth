"use client";

/**
 * KAN-859 — Payments tab. Spec §7.6 framing.
 *
 * Save flow mirrors Cohorts 2/3: optimistic update with revert on
 * error, dirty-state button labels.
 *
 * Decision notes:
 *  - Default currency drives the `AdditionalCurrenciesMultiSelect`
 *    exclusion + the Fixed deposit amount label (`Amount in {code}`).
 *  - When the user changes default currency, any matching entry in
 *    additionalCurrencies is auto-removed (server schema enforces this
 *    via `additionalCurrencies must not include defaultCurrency` cross-
 *    field refinement; we mirror client-side to keep the UI sane).
 *  - Deposit policy: flat-3-column shape on AccountProfile mapped from
 *    the ternary mode (none / percentage / fixed) by DepositPolicyEditor.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { trpcQuery, trpcMutation } from "@/lib/api";
import {
  PaymentMethodsCheckboxGroup,
  type AcceptedPaymentMethod,
} from "../_components/payment-methods-checkbox-group";
import { CurrencySelect } from "../_components/currency-select";
import { AdditionalCurrenciesMultiSelect } from "../_components/additional-currencies-multi-select";
import { DepositPolicyEditor } from "../_components/deposit-policy-editor";
import { RefundWindowInput } from "../_components/refund-window-input";

interface AccountProfile {
  defaultCurrency: string;
  additionalCurrencies: string[];
  acceptedPaymentMethods: AcceptedPaymentMethod[];
  depositRequired: boolean;
  depositType: "percentage" | "fixed" | null;
  /** Prisma serialises Decimal as string. Coerce at the boundary. */
  depositValue: string | number | null;
  refundWindowDays: number | null;
}

interface PaymentsFormState {
  defaultCurrency: string;
  additionalCurrencies: string[];
  acceptedPaymentMethods: AcceptedPaymentMethod[];
  depositRequired: boolean;
  depositType: "percentage" | "fixed" | null;
  depositValue: number | null;
  refundWindowDays: number | null;
}

function decimalToNumber(d: string | number | null): number | null {
  if (d == null) return null;
  if (typeof d === "number") return d;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

function profileToForm(p: AccountProfile): PaymentsFormState {
  return {
    defaultCurrency: p.defaultCurrency ?? "USD",
    additionalCurrencies: p.additionalCurrencies ?? [],
    acceptedPaymentMethods: p.acceptedPaymentMethods ?? [],
    depositRequired: p.depositRequired ?? false,
    depositType: p.depositType ?? null,
    depositValue: decimalToNumber(p.depositValue),
    refundWindowDays: p.refundWindowDays ?? null,
  };
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffPatch(
  before: PaymentsFormState,
  after: PaymentsFormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.defaultCurrency !== after.defaultCurrency)
    patch.defaultCurrency = after.defaultCurrency;
  if (!arraysEqual(before.additionalCurrencies, after.additionalCurrencies))
    patch.additionalCurrencies = after.additionalCurrencies;
  if (!arraysEqual(before.acceptedPaymentMethods, after.acceptedPaymentMethods))
    patch.acceptedPaymentMethods = after.acceptedPaymentMethods;
  if (
    before.depositRequired !== after.depositRequired ||
    before.depositType !== after.depositType ||
    before.depositValue !== after.depositValue
  ) {
    patch.depositRequired = after.depositRequired;
    patch.depositType = after.depositRequired ? after.depositType : null;
    patch.depositValue = after.depositRequired ? after.depositValue : null;
  }
  if (before.refundWindowDays !== after.refundWindowDays)
    patch.refundWindowDays = after.refundWindowDays;
  return patch;
}

export default function PaymentsTabPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const accountQuery = useQuery<AccountProfile>({
    queryKey: ["account", "get"],
    queryFn: () => trpcQuery<AccountProfile>("account.get"),
  });

  const [form, setForm] = React.useState<PaymentsFormState | null>(null);
  const [snapshot, setSnapshot] = React.useState<PaymentsFormState | null>(null);

  React.useEffect(() => {
    if (!accountQuery.data) return;
    const next = profileToForm(accountQuery.data);
    setSnapshot(next);
    if (form === null) setForm(next);
  }, [accountQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<AccountProfile> => {
      return trpcMutation<AccountProfile>("account.updatePayments", patch);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["account", "get"], (prev: AccountProfile | undefined) =>
        prev ? { ...prev, ...data } : data,
      );
      const next = profileToForm({ ...(accountQuery.data ?? data), ...data });
      setSnapshot(next);
      setForm(next);
      toast.success("Payments saved.");
    },
    onError: (err: Error) => {
      if (snapshot) setForm(snapshot);
      toast.error(err.message || "Couldn't save. Try again.");
    },
  });

  if (accountQuery.isLoading || !form || !snapshot) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" aria-label="Loading payments">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-10 rounded animate-pulse"
                style={{ backgroundColor: "var(--ds-surface-sunken)" }}
                aria-hidden="true"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (accountQuery.isError) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
            Couldn&apos;t load your account. Refresh and try again.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void accountQuery.refetch()}
            aria-label="Retry loading account"
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const patch = diffPatch(snapshot, form);
  const isDirty = Object.keys(patch).length > 0;
  const canSave = isDirty && !saveMutation.isPending;

  function handleDefaultCurrencyChange(next: string): void {
    if (!form) return;
    // Auto-drop the new default from additionalCurrencies if present.
    const additionalNext = form.additionalCurrencies.filter((c) => c !== next);
    setForm({ ...form, defaultCurrency: next, additionalCurrencies: additionalNext });
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>
          Currencies, payment methods, deposit policy, and refund window the
          AI cites when contacts ask how to pay.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="default-currency">Default currency</Label>
          <CurrencySelect
            id="default-currency"
            value={form.defaultCurrency}
            onChange={handleDefaultCurrencyChange}
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            The currency AI quotes by default when discussing pricing.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Additional currencies</Label>
          <AdditionalCurrenciesMultiSelect
            value={form.additionalCurrencies}
            excludedCode={form.defaultCurrency}
            onChange={(next) =>
              setForm({ ...form, additionalCurrencies: next })
            }
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Accepted payment methods</Label>
          <PaymentMethodsCheckboxGroup
            value={form.acceptedPaymentMethods}
            onChange={(next) =>
              setForm({ ...form, acceptedPaymentMethods: next })
            }
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Deposit policy</Label>
          <DepositPolicyEditor
            required={form.depositRequired}
            type={form.depositType}
            amount={form.depositValue}
            defaultCurrencyCode={form.defaultCurrency}
            onChange={(next) =>
              setForm({
                ...form,
                depositRequired: next.required,
                depositType: next.type,
                depositValue: next.amount,
              })
            }
          />
        </div>

        <RefundWindowInput
          value={form.refundWindowDays}
          onChange={(next) => setForm({ ...form, refundWindowDays: next })}
        />
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => saveMutation.mutate(patch)}
          aria-label="Save payments"
        >
          {saveMutation.isPending
            ? "Saving…"
            : isDirty
              ? "Save changes"
              : "No changes to save"}
        </Button>
      </CardFooter>
    </Card>
  );
}
