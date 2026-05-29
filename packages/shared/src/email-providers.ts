/**
 * M3-2.5a — known email provider value space + soft validator + sidecar type.
 *
 * The DB column for `provider` is TEXT (not Postgres enum) per the
 * sub-objective-key precedent established in M3-1: enum-grow-by-migration
 * is a known trap. `KNOWN_EMAIL_PROVIDERS` is a reference list for
 * documentation + UI/admin tooling + soft-type checking; the Zod
 * validator accepts any non-empty string at the storage layer so
 * future providers (Postmark / Mailgun / SES) land without a schema
 * migration.
 */
import { z } from 'zod';

/**
 * Reference list of email providers the codebase knows about. NOT a hard
 * constraint at the storage layer — accept any TEXT and treat unknown
 * values as forward-compat. Today: only 'resend' has a live adapter.
 */
export const KNOWN_EMAIL_PROVIDERS = [
  'resend',
  'postmark',
  'mailgun',
  'ses',
  'sendgrid',
] as const;
export type KnownEmailProvider = (typeof KNOWN_EMAIL_PROVIDERS)[number];

/**
 * Soft validator. Accepts any non-empty TEXT — KNOWN_EMAIL_PROVIDERS is
 * reference, not gate. Pattern matches sub-objective-key validator from M3-1.
 */
export const EmailProviderSchema = z.string().min(1);

/**
 * EngagementEmailMetadata — 1:1 sidecar to Engagement rows, holds email-
 * wire metadata (provider, message-id, in-reply-to, references chain).
 * Outbound rows write `provider` + `providerMessageId`; inbound rows
 * additionally populate `inReplyTo` + `referencesArray` for the M3-2.5b
 * correlation lookup.
 */
export interface EngagementEmailMetadataRecord {
  engagementId: string;
  provider: string;
  providerMessageId: string;
  /** Inbound only; populated in M3-2.5b. Outbound rows have null. */
  inReplyTo: string | null;
  /** Inbound only; RFC-5322 References header parsed to an array. */
  referencesArray: string[];
  createdAt: Date;
}
