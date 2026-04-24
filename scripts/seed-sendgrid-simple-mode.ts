/**
 * One-shot seed: insert a ChannelConnection row per-tenant for the SendGrid
 * simple-mode adapter path (KAN-661).
 *
 * The simple-mode branch of SendGridAdapter.send() keys off
 * `metadata.mode === 'simple'` and uses a single global SENDGRID_API_KEY env var
 * plus `metadata.fromEmail` / `metadata.fromName` — no per-tenant Secret Manager
 * entry, no subuser, no domain-auth gate (those all belong to KAN-473).
 *
 * Usage:
 *   npx tsx scripts/seed-sendgrid-simple-mode.ts                       # seeds the AxisOne Growth tenant (default slug)
 *   npx tsx scripts/seed-sendgrid-simple-mode.ts <tenantSlug>          # seeds a specific tenant by slug
 *   FROM_EMAIL=... FROM_NAME=... npx tsx scripts/seed-sendgrid-simple-mode.ts
 *
 * Idempotent: uses upsert on the ChannelConnection unique
 * (tenantId, channelType, providerAccountId).
 */
import { PrismaClient, Prisma } from '@prisma/client';

const DEFAULT_TENANT_SLUG = 'axisone-growth';
const DEFAULT_FROM_EMAIL = 'hello@growth.axisone.com';
const DEFAULT_FROM_NAME = 'growth';
const CREDENTIALS_REF =
  'projects/growth-493400/secrets/sendgrid-api-key/versions/latest';
const PROVIDER_ACCOUNT_ID = 'sendgrid-simple'; // unique per tenant across simple-mode

async function main() {
  const prisma = new PrismaClient();
  const slug = process.argv[2] ?? DEFAULT_TENANT_SLUG;
  const fromEmail = process.env.FROM_EMAIL ?? DEFAULT_FROM_EMAIL;
  const fromName = process.env.FROM_NAME ?? DEFAULT_FROM_NAME;

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`tenant with slug "${slug}" not found`);
    process.exit(1);
  }

  const metadata: Prisma.InputJsonValue = {
    mode: 'simple',
    fromEmail,
    fromName,
    domainAuthStatus: 'none', // simple mode doesn't use the domain-auth gate
  };

  const conn = await prisma.channelConnection.upsert({
    where: {
      tenantId_channelType_providerAccountId: {
        tenantId: tenant.id,
        channelType: 'EMAIL',
        providerAccountId: PROVIDER_ACCOUNT_ID,
      },
    },
    create: {
      tenantId: tenant.id,
      channelType: 'EMAIL',
      provider: 'sendgrid',
      providerAccountId: PROVIDER_ACCOUNT_ID,
      status: 'ACTIVE',
      credentialsRef: CREDENTIALS_REF,
      label: 'SendGrid (simple mode)',
      metadata,
      connectedAt: new Date(),
    },
    update: {
      status: 'ACTIVE',
      credentialsRef: CREDENTIALS_REF,
      metadata,
      label: 'SendGrid (simple mode)',
      updatedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenantSlug: slug,
        tenantId: tenant.id,
        connectionId: conn.id,
        fromEmail,
        fromName,
        credentialsRef: CREDENTIALS_REF,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
