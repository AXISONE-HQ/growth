"use client";

/**
 * KAN-857 Decision 8 — MailingAddressFields with same-as-physical Switch.
 *
 * Behavior:
 *   - Initial render: Switch on, mailing fields hidden
 *   - Toggle off → mailing fields appear EMPTY (no pre-fill from physical)
 *   - On save with Switch on → server-side updateContact wrapper
 *     explicitly nulls mailingAddress (see router.ts handler)
 *   - Toggle back on after entering mailing → server clears it on next save
 *
 * The same-as-physical state is owned by the parent (Contact tab page);
 * this component is presentational + emits onChange events upward.
 */
import * as React from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

interface MailingAddressFieldsProps {
  sameAsPhysical: boolean;
  mailingAddress: string;
  onSameAsPhysicalChange: (next: boolean) => void;
  onMailingAddressChange: (next: string) => void;
}

export function MailingAddressFields({
  sameAsPhysical,
  mailingAddress,
  onSameAsPhysicalChange,
  onMailingAddressChange,
}: MailingAddressFieldsProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="mailing-same-as-physical" className="cursor-pointer">
          Mailing address is the same as physical
        </Label>
        <Switch
          id="mailing-same-as-physical"
          checked={sameAsPhysical}
          onCheckedChange={onSameAsPhysicalChange}
          aria-label="Mailing address is the same as physical"
        />
      </div>
      {!sameAsPhysical ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="mailing-address">Mailing address</Label>
          <Textarea
            id="mailing-address"
            value={mailingAddress}
            onChange={(e) => onMailingAddressChange(e.target.value)}
            rows={3}
            placeholder="Street, city, region, postal code, country"
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            Used when correspondence needs a different return address than
            your physical location.
          </p>
        </div>
      ) : null}
    </div>
  );
}
