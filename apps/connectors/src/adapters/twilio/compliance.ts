/**
 * Twilio 10DLC compliance — Trust Hub Brand + A2P Campaign submission.
 *
 * US carriers require that every SMS-capable 10DLC number be associated
 * with a registered Brand (the business sending) and a Campaign (the
 * use case). Without these, messages are filtered or silently dropped.
 *
 * This flow is asynchronous: we submit, then poll status. Turnaround is
 * typically 24–72 hours. The tenant's connection stays in PENDING status
 * until `campaign.status === 'VERIFIED'`.
 *
 * Flow (simplified):
 *   1. Create Secondary Customer Profile (the tenant's legal entity)
 *   2. Attach business info to the profile
 *   3. Submit the profile for review (creates a Customer Profile Bundle)
 *   4. Once approved, create a Brand Registration pointing at the bundle
 *   5. Create an A2P Messaging Service Use Case (campaign)
 *   6. Attach campaign to the Messaging Service SID
 *
 * Reference: https://www.twilio.com/docs/messaging/a2p-10dlc
 *
 * KAN-493, KAN-569, KAN-570, KAN-571
 */

import type Twilio from 'twilio';
import { logger } from '../../logger.js';
import type { TwilioConnectParams } from './provisioning.js';

export type ComplianceStatus = 'pending' | 'in-review' | 'approved' | 'rejected';

export interface BrandAndCampaignState {
  customerProfileSid?: string;
  trustProductSid?: string;
  brandRegistrationSid?: string;
  usAppToPersonSid?: string;
  brandStatus: ComplianceStatus;
  campaignStatus: ComplianceStatus;
  rejectionReason?: string;
}

/**
 * Submit the tenant's Brand and A2P Campaign for carrier review.
 * Returns the SIDs and initial status; poll separately via pollComplianceStatus.
 */
export async function submitBrandAndCampaign(
  client: Twilio.Twilio,
  params: TwilioConnectParams,
  messagingServiceSid: string,
): Promise<BrandAndCampaignState> {
  const log = logger.child({ subaccountSid: client.accountSid });
  log.info('starting 10DLC submission');

  // Step 1: Secondary Customer Profile (the legal entity)
  const customerProfile = await client.trusthub.v1.customerProfiles.create({
    friendlyName: `${params.businessName} — Customer Profile`,
    email: `compliance+${client.accountSid}@axisone.ca`,
    policySid: 'RNdfbf3fae0e1107f8aded728e5d0ef087', // Customer Profile policy SID (public)
  });
  log.info({ sid: customerProfile.sid }, 'customer profile created');

  // Step 2: Attach business info end-user to the profile
  const endUser = await client.trusthub.v1.endUsers.create({
    friendlyName: `${params.businessName} — Business Info`,
    type: 'customer_profile_business_information',
    attributes: {
      business_name: params.businessName,
      business_type: params.useCase,
      business_registration_identifier: 'EIN',
      business_registration_number: params.businessEIN,
      business_regions_of_operation: 'USA_AND_CANADA',
      website_url: params.businessWebsite,
      business_industry: 'TECHNOLOGY',
    },
  });
  await client.trusthub.v1.customerProfiles(customerProfile.sid).customerProfilesEntityAssignments.create({
    objectSid: endUser.sid,
  });

  // Step 3: Submit profile for review
  await client.trusthub.v1.customerProfiles(customerProfile.sid).update({ status: 'pending-review' });
  log.info({ sid: customerProfile.sid }, 'customer profile submitted for review');

  // Step 4: Trust Product (A2P Messaging Profile) — links the tenant profile to the A2P use case
  const trustProduct = await client.trusthub.v1.trustProducts.create({
    friendlyName: `${params.businessName} — A2P Profile`,
    email: `compliance+${client.accountSid}@axisone.ca`,
    policySid: 'RNb0d4771c2c98518d916a6f92ebe744b1', // A2P Messaging policy SID (public)
  });
  await client.trusthub.v1.trustProducts(trustProduct.sid).trustProductsEntityAssignments.create({
    objectSid: customerProfile.sid,
  });

  // Step 5: Brand Registration
  const brand = await client.messaging.v1.brandRegistrations.create({
    customerProfileBundleSid: customerProfile.sid,
    a2PProfileBundleSid: trustProduct.sid,
    brandType: 'STANDARD',
  });
  log.info({ brandSid: brand.sid, status: brand.status }, 'brand registration submitted');

  // Step 6: A2P Messaging Campaign (usAppToPerson) attached to the Messaging Service
  const campaign = await client.messaging.v1.services(messagingServiceSid).usAppToPerson.create({
    brandRegistrationSid: brand.sid,
    description: `Automated messages from ${params.businessName} per their customer communications`,
    messageSamples: params.sampleMessages,
    usAppToPersonUsecase: params.useCase,
    hasEmbeddedLinks: true,
    hasEmbeddedPhone: false,
  });
  log.info({ campaignSid: campaign.sid }, 'A2P campaign submitted');

  return {
    customerProfileSid: customerProfile.sid,
    trustProductSid: trustProduct.sid,
    brandRegistrationSid: brand.sid,
    usAppToPersonSid: campaign.sid,
    brandStatus: mapBrandStatus(brand.status),
    campaignStatus: 'pending',
  };
}

/** Poll the current Brand + Campaign status. Called by the cron in status-poller.ts. */
export async function pollComplianceStatus(
  client: Twilio.Twilio,
  state: BrandAndCampaignState,
  messagingServiceSid: string,
): Promise<BrandAndCampaignState> {
  if (!state.brandRegistrationSid || !state.usAppToPersonSid) {
    return state;
  }

  const brand = await client.messaging.v1.brandRegistrations(state.brandRegistrationSid).fetch();
  const campaign = await client.messaging.v1
    .services(messagingServiceSid)
    .usAppToPerson(state.usAppToPersonSid)
    .fetch();

  return {
    ...state,
    brandStatus: mapBrandStatus(brand.status),
    campaignStatus: mapCampaignStatus(campaign.campaignStatus ?? 'PENDING'),
    rejectionReason: brand.failureReason ?? undefined,
  };
}

function mapBrandStatus(s: string): ComplianceStatus {
  switch (s.toUpperCase()) {
    case 'PENDING':
    case 'IN_REVIEW':
      return 'in-review';
    case 'APPROVED':
    case 'VERIFIED':
      return 'approved';
    case 'FAILED':
    case 'REJECTED':
      return 'rejected';
    default:
      return 'pending';
  }
}

function mapCampaignStatus(s: string): ComplianceStatus {
  switch (s.toUpperCase()) {
    case 'PENDING':
    case 'IN_PROGRESS':
      return 'in-review';
    case 'VERIFIED':
    case 'APPROVED':
      return 'approved';
    case 'FAILED':
      return 'rejected';
    default:
      return 'pending';
  }
}

/** Connection is ready to send only when both brand AND campaign are approved. */
export function isSendable(state: BrandAndCampaignState): boolean {
  return state.brandStatus === 'approved' && state.campaignStatus === 'approved';
}
