import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const TID = process.env.SEED_TENANT_ID!;
if (!TID) { console.error('Set SEED_TENANT_ID'); process.exit(1); }
const comps = [
  { name: 'HubSpot', website: 'https://hubspot.com', description: 'Inbound marketing, sales, and CRM platform', status: 'active' },
  { name: 'Salesforce', website: 'https://salesforce.com', description: 'Enterprise CRM and sales automation', status: 'active' },
  { name: 'Outreach', website: 'https://outreach.io', description: 'Sales engagement platform', status: 'active' },
  { name: 'Apollo.io', website: 'https://apollo.io', description: 'Sales intelligence and engagement', status: 'active' },
  { name: 'Gong', website: 'https://gong.io', description: 'Revenue intelligence platform', status: 'active' },
  { name: 'Drift', website: 'https://drift.com', description: 'Conversational marketing and sales', status: 'active' },
  { name: 'Clari', website: 'https://clari.com', description: 'Revenue operations platform', status: 'active' },
  { name: 'Salesloft', website: 'https://salesloft.com', description: 'Sales engagement and analytics', status: 'active' },
  { name: '6sense', website: 'https://6sense.com', description: 'ABM and predictive intelligence', status: 'active' },
  { name: 'ZoomInfo', website: 'https://zoominfo.com', description: 'B2B contact and company data', status: 'active' },
];
async function main() {
  console.log('Seeding competitors for tenant ' + TID);
  for (const c of comps) {
    const r = await prisma.competitor.create({ data: {
      tenantId: TID, name: c.name, website: c.website, description: c.description, status: c.status as any,
      battleCards: { create: {
        overview: c.name + ' is a key competitor. They have strong brand recognition but higher costs and slower innovation compared to growth.',
        strengths: ['Market leader', 'Brand recognition', 'Large ecosystem'],
        weaknesses: ['Complex pricing', 'Slow innovation', 'High cost'],
        differentiators: ['AI-native approach', 'Unified loop architecture'],
        objections: ['We already use ' + c.name, 'Migration concerns'],
        talkingPoints: ['Faster time to value', 'Lower TCO', 'AI-driven decisions'],
        updatedAt: new Date(),
      }},
      news: { create: {
        title: c.name + ' announces Q1 2026 results',
        sourceUrl: 'https://example.com/news/' + c.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        summary: c.name + ' reported growth in enterprise segment with new AI features.',
        sentiment: 'neutral' as any,
        publishedAt: new Date(),
      }},
    }});
    console.log('  Created: ' + r.name + ' (' + r.id + ')');
  }
  console.log('Done! 10 competitors seeded.');
}
main().catch(console.error).finally(() => prisma.$disconnect());
