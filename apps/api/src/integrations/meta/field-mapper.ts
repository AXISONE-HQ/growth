/**
 * Meta Lead Ads → Contact Field Mapper
 * Maps Meta form field names to the growth Contact schema.
 */

import type { MetaLeadField } from "./graph-api.js";

export interface MappedContact {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  segment: string;
  dataQualityScore: number;
  externalIds: {
    meta: {
      leadgen_id: string;
      form_id?: string;
      ad_id?: string;
      adset_id?: string;
      campaign_id?: string;
    };
    meta_fields: Record<string, string>;
  };
}

/**
 * Split a full name into first and last name.
 */
function splitFullName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

/**
 * Map Meta Lead Ads field_data to a normalized contact object.
 */
export function mapMetaFieldsToContact(
  fieldData: MetaLeadField[],
  leadgenId: string,
  formId?: string,
  adId?: string,
  adsetId?: string,
  campaignId?: string
): MappedContact | null {
  const fields: Record<string, string> = {};
  for (const field of fieldData) {
    if (field.values && field.values.length > 0) {
      fields[field.name.toLowerCase()] = field.values[0];
    }
  }

  // Email is required — can't create a contact without it
  const email = fields["email"];
  if (!email) {
    console.warn(`Meta lead ${leadgenId} has no email field — skipping`);
    return null;
  }

  // Build the contact
  const contact: MappedContact = {
    email: email.toLowerCase().trim(),
    segment: "meta_lead_ad",
    dataQualityScore: 0,
    externalIds: {
      meta: {
        leadgen_id: leadgenId,
        ...(formId && { form_id: formId }),
        ...(adId && { ad_id: adId }),
        ...(adsetId && { adset_id: adsetId }),
        ...(campaignId && { campaign_id: campaignId }),
      },
      meta_fields: {},
    },
  };

  // Map known fields
  let knownFieldCount = 1; // email counts as 1

  if (fields["first_name"]) {
    contact.firstName = fields["first_name"];
    knownFieldCount++;
  }
  if (fields["last_name"]) {
    contact.lastName = fields["last_name"];
    knownFieldCount++;
  }
  if (fields["full_name"] && !contact.firstName) {
    const { firstName, lastName } = splitFullName(fields["full_name"]);
    contact.firstName = firstName;
    if (lastName) contact.lastName = lastName;
    knownFieldCount++;
  }
  if (fields["phone_number"] || fields["phone"]) {
    contact.phone = fields["phone_number"] || fields["phone"];
    knownFieldCount++;
  }
  if (fields["company_name"] || fields["company"]) {
    contact.company = fields["company_name"] || fields["company"];
    knownFieldCount++;
  }

  // Store unmapped fields in meta_fields for future use
  const knownKeys = new Set([
    "email", "first_name", "last_name", "full_name",
    "phone_number", "phone", "company_name", "company",
  ]);
  for (const [key, value] of Object.entries(fields)) {
    if (!knownKeys.has(key)) {
      contact.externalIds.meta_fields[key] = value;
    }
  }

  // Data quality score: 0-100 based on field completeness
  // 5 core fields (email, firstName, lastName, phone, company) = 20 pts each
  contact.dataQualityScore = Math.min(100, knownFieldCount * 20);

  return contact;
}
