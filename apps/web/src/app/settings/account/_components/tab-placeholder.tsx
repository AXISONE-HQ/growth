/**
 * KAN-855 — Account Page Cohort 2. Single placeholder for the 4 future-
 * cohort tabs. Cohort 3 (Contact + Hours) and Cohort 4 (Payments +
 * Legal) replace these calls with real pages — DRY now means each
 * placeholder is one prop change, no copy-paste.
 *
 * Copy approved by Fred (no double "coming soon"):
 *   Contact:  "Contact details" + "Phone, address, and service area land here next."
 *   Hours:    "Business hours" + "Weekly hours, time zone, and observed holidays land here next."
 *   Payments: "Payment methods" + "Accepted methods, currencies, and deposit policy land here in a future release."
 *   Legal:    "Legal & compliance" + "Tax ID, jurisdiction, opt-out language, and disclosures land here in a future release."
 */
import * as React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface TabPlaceholderProps {
  heading: string;
  body: string;
}

export function TabPlaceholder({ heading, body }: TabPlaceholderProps): React.ReactElement {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent
        className="text-sm py-12 text-center"
        style={{ color: "var(--ds-ink-tertiary)" }}
      >
        This tab is under construction.
      </CardContent>
    </Card>
  );
}
