/**
 * KAN-884 — small renderer for a structured address.
 *
 * Used by the Company detail page for billing + mailing cards. Skips empty
 * lines so a partially-filled address renders cleanly rather than producing
 * blank rows ("Acme HQ\n\n\nUSA").
 *
 * Returns null when ALL fields are blank so the parent can decide between
 * "show a placeholder string" or "hide the card entirely."
 */
interface AddressBlockProps {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  className?: string;
}

export function AddressBlock({
  addressLine1,
  addressLine2,
  city,
  region,
  postalCode,
  country,
  className,
}: AddressBlockProps) {
  const cityLine = [city, region, postalCode].filter(Boolean).join(", ");
  const lines = [addressLine1, addressLine2, cityLine, country].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  );
}

/** True when every address field is blank/null. Lets callers decide their
 *  empty-state copy ("No billing address on file" vs "Same as billing"). */
export function isAddressEmpty(addr: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): boolean {
  return (
    !addr.addressLine1 &&
    !addr.addressLine2 &&
    !addr.city &&
    !addr.region &&
    !addr.postalCode &&
    !addr.country
  );
}
