import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const existing = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (existing) {
    console.log('Tenant already exists:', existing.id, existing.name);
    return;
  }
  const tenant = await prisma.tenant.create({
    data: {
      id: tenantId,
      name: 'AxisOne Demo',
      planTier: 'professional',
      confidenceThreshold: 70,
      aiPermissions: { directConversion: true, guidedAssistance: true, trustBuilding: true, reengagement: true },
    },
  });
  console.log('Created tenant:', tenant.id, tenant.name);
}
main().catch(console.error).finally(() => prisma.$disconnect());
