/**
 * KAN-884 — money renderer.
 *
 * Prisma's `Decimal(12,2)` columns serialize over tRPC as JSON STRINGS
 * (e.g., `"1234.56"`), NOT JavaScript numbers — Decimal precision can't
 * round-trip through IEEE-754 doubles safely. The tRPC layer at KAN-883
 * preserves this default behavior (no superjson transformer registered),
 * so every order amount and deal value lands here as a string.
 *
 * This component:
 *   - accepts both string (Decimal) and number inputs for ergonomics
 *   - parses string → number ONCE for formatting (precision-loss risk is
 *     acceptable for DISPLAY; the canonical value stays string elsewhere)
 *   - uses Intl.NumberFormat with the row's currency code (USD/CAD/EUR/etc.)
 *   - falls back to "—" when the value is missing/unparseable
 *
 * Do NOT use this output for arithmetic. Pull the string straight from the
 * tRPC payload + use Big.js / Decimal.js in a future cohort if math is
 * needed UI-side.
 */
interface MoneyDisplayProps {
  /** Prisma Decimal serialized as JSON string, or already a number. */
  value: string | number | null | undefined;
  /** ISO 4217 currency code. Defaults to USD if missing. */
  currency?: string | null;
  /** Show the symbol (`$1,234.56`) vs symbol-less (`1,234.56`). Default true. */
  showCurrency?: boolean;
  className?: string;
}

export function MoneyDisplay({
  value,
  currency,
  showCurrency = true,
  className,
}: MoneyDisplayProps) {
  if (value == null) return <span className={className}>—</span>;
  const num = typeof value === "string" ? Number.parseFloat(value) : value;
  if (!Number.isFinite(num)) return <span className={className}>—</span>;
  const cur = currency ?? "USD";
  const formatted = new Intl.NumberFormat("en-US", {
    style: showCurrency ? "currency" : "decimal",
    currency: showCurrency ? cur : undefined,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
  return <span className={className}>{formatted}</span>;
}
