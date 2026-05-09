/**
 * KAN-855 — /settings/account → /settings/account/identity redirect.
 * Server-side redirect so deep-link bookmarks land on a real tab.
 */
import { redirect } from "next/navigation";

export default function AccountIndexPage(): never {
  redirect("/settings/account/identity");
}
