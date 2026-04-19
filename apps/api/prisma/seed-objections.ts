import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SEED_TENANT_ID = process.env.SEED_TENANT_ID || "00000000-0000-0000-0000-000000000001";

interface ObjectionSeed {
  objectionText: string;
  category: "pricing" | "competition" | "trust" | "timing" | "product" | "authority" | "need" | "other";
  trend: "hot" | "rising" | "stable" | "declining";
  mentionCount: number;
  winRate: number;
  lastMentionedAt: Date;
  responses: {
    fieldName: string;
    content: string;
  }[];
}

const objections: ObjectionSeed[] = [
  {
    objectionText: "Your pricing is too high compared to competitors",
    category: "pricing",
    trend: "hot",
    mentionCount: 47,
    winRate: 62,
    lastMentionedAt: new Date("2026-04-17"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "I understand budget is important. What many clients discover is that our total cost of ownership is actually 30-40% lower when you factor in the automation savings. Our AI handles tasks that would require 2-3 additional headcount with manual tools. Let me show you the ROI calculator — most teams see payback within 60 days.",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Acknowledge the concern genuinely. 2) Shift from price to value — frame as investment, not cost. 3) Reference the ROI calculator with their specific metrics. 4) Share the case study from [similar industry] showing 3.2x ROI. 5) Offer the pilot program: 30-day trial at reduced rate to prove value before full commitment.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• AI automation replaces 2-3 FTE worth of manual work — net savings of $80-120K/year\n• 30-40% lower total cost of ownership vs. competitors when factoring automation\n• ROI calculator shows average payback in 47 days across all customers\n• No hidden fees — flat per-seat pricing includes all AI features\n• 30-day money-back guarantee removes all financial risk",
      },
    ],
  },
  {
    objectionText: "We're already using HubSpot and don't want to switch",
    category: "competition",
    trend: "rising",
    mentionCount: 31,
    winRate: 45,
    lastMentionedAt: new Date("2026-04-16"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "That makes sense — HubSpot is a solid CRM. The good news is growth doesn't replace HubSpot, it supercharges it. We integrate natively via our connector layer, so your team keeps using HubSpot while our AI handles the revenue intelligence layer on top. Most of our customers run both — growth reads from and writes back to HubSpot automatically.",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Validate their investment in HubSpot — don't compete with it. 2) Position growth as a complementary layer, not a replacement. 3) Show the native HubSpot integration via Nango connector. 4) Demo the AI decision engine working ON TOP of HubSpot data. 5) Reference customers who use both — 67% of our base integrates with HubSpot.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• Native HubSpot integration — bidirectional sync, no data migration needed\n• AI decision engine layer that HubSpot doesn't offer\n• 67% of growth customers run HubSpot + growth together\n• Setup takes <30 minutes with our guided connector wizard\n• All HubSpot data enriched with AI insights automatically",
      },
    ],
  },
  {
    objectionText: "How do I know the AI won't send embarrassing messages to my customers?",
    category: "trust",
    trend: "stable",
    mentionCount: 23,
    winRate: 78,
    lastMentionedAt: new Date("2026-04-15"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "That's one of the most important questions to ask, and I'm glad you raised it. Every message goes through our 5-layer guardrail system before it reaches a customer: tone validation, accuracy check against your company data, hallucination filter, compliance check (CAN-SPAM, CASL, GDPR), and a confidence gate. If the AI isn't confident enough, it routes to your team instead of sending. You always have full control.",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Affirm the concern — this shows they take their brand seriously. 2) Walk through the 5-layer guardrail system visually (show the architecture diagram). 3) Explain the confidence threshold — they set the bar for auto-send vs. human review. 4) Show the audit log where every AI action is tracked and reviewable. 5) Offer a sandbox demo where they can test the guardrails with their own brand voice.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• 5-layer guardrail system checks every message before sending\n• Configurable confidence threshold — you control when AI auto-sends vs. asks for approval\n• Complete audit log tracks every AI decision with full reasoning\n• Brand voice training ensures messages match your tone\n• Zero hallucination tolerance — claims are checked against your Company Truth data",
      },
    ],
  },
  {
    objectionText: "We need to see results before committing to an annual plan",
    category: "timing",
    trend: "rising",
    mentionCount: 19,
    winRate: 71,
    lastMentionedAt: new Date("2026-04-17"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "Completely fair — we believe in earning your commitment through results, not contracts. That's why we offer a 30-day pilot where you run growth on a subset of your pipeline with full AI capabilities. Most teams see measurable lift in response rates and conversion within the first two weeks. After the pilot, you'll have real data to make your decision.",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Agree with the principle — results should precede commitment. 2) Introduce the 30-day pilot program with full capabilities. 3) Define success metrics together — what would 'results' look like for them? 4) Share pilot-to-paid conversion stat: 84% of pilot customers convert to annual. 5) Set a check-in at day 14 to review early results together.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• 30-day full-feature pilot — no feature gating during trial\n• 84% pilot-to-paid conversion rate proves value speaks for itself\n• Measurable results within 14 days on average\n• Custom success metrics defined with your team before pilot starts\n• Month-to-month option available if annual feels too early",
      },
    ],
  },
  {
    objectionText: "Our team doesn't have time to learn another tool",
    category: "product",
    trend: "declining",
    mentionCount: 14,
    winRate: 82,
    lastMentionedAt: new Date("2026-04-09"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "I hear that a lot, and it's exactly why we built growth the way we did. The AI does the heavy lifting — your team doesn't need to learn a complex new interface. The onboarding wizard takes about 15 minutes, and after that, the AI starts working autonomously. Most users spend less time managing growth than they did doing the manual tasks it replaces.",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Acknowledge time is their scarcest resource. 2) Reframe: growth saves time, it doesn't consume it. 3) Walk through the 15-minute onboarding wizard. 4) Show the AI working autonomously — team only intervenes on escalations. 5) Share the stat: average user saves 8+ hours/week after the first month.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• 15-minute guided onboarding — no training required\n• AI works autonomously — team only handles escalations\n• Average time savings of 8+ hours per user per week\n• Familiar interface patterns — if you've used a CRM, you can use growth\n• Dedicated onboarding specialist for first 30 days at no extra cost",
      },
    ],
  },
  {
    objectionText: "I need to get buy-in from my VP before we can move forward",
    category: "authority",
    trend: "stable",
    mentionCount: 18,
    winRate: 55,
    lastMentionedAt: new Date("2026-04-14"),
    responses: [
      {
        fieldName: "recommendedResponse",
        content:
          "Absolutely — getting executive alignment is important. I can help make that easier. We have a VP-ready ROI deck that shows projected impact based on your specific pipeline data. I can also set up a 15-minute executive briefing where we focus purely on the business case and expected outcomes. What does your VP care most about — revenue lift, cost savings, or team productivity?",
      },
      {
        fieldName: "talkTrack",
        content:
          "1) Validate the multi-stakeholder process — never bypass the champion. 2) Ask what matters most to their VP (revenue, costs, productivity). 3) Offer the VP-ready ROI deck customized to their data. 4) Propose a 15-minute executive briefing — short, focused, numbers-driven. 5) Equip the champion with a one-pager they can share internally.",
      },
      {
        fieldName: "keyDifferentiators",
        content:
          "• VP-ready ROI deck customized with prospect's actual pipeline data\n• 15-minute executive briefing option — respects senior leaders' time\n• Champion enablement kit: one-pager, ROI summary, competitive comparison\n• Customer references available — VP-to-VP calls with similar companies\n• Enterprise security documentation ready for IT review",
      },
    ],
  },
];

async function seedObjections() {
  console.log("🎯 Seeding Sales Objections...\n");

  // Verify tenant exists
  const tenant = await prisma.tenant.findUnique({
    where: { id: SEED_TENANT_ID },
  });

  if (!tenant) {
    console.error(`❌ Tenant ${SEED_TENANT_ID} not found. Create the tenant first.`);
    process.exit(1);
  }

  console.log(`📌 Tenant: ${tenant.name} (${tenant.id})\n`);

  for (const obj of objections) {
    // Upsert objection by tenant + text
    const existing = await prisma.salesObjection.findFirst({
      where: {
        tenantId: SEED_TENANT_ID,
        objectionText: obj.objectionText,
      },
    });

    let objection;
    if (existing) {
      objection = await prisma.salesObjection.update({
        where: { id: existing.id },
        data: {
          category: obj.category,
          trend: obj.trend,
          mentionCount: obj.mentionCount,
          winRate: obj.winRate,
          lastMentionedAt: obj.lastMentionedAt,
        },
      });
      console.log(`  ✏️  Updated: "${obj.objectionText.substring(0, 50)}..."`);
    } else {
      objection = await prisma.salesObjection.create({
        data: {
          tenantId: SEED_TENANT_ID,
          objectionText: obj.objectionText,
          category: obj.category,
          trend: obj.trend,
          mentionCount: obj.mentionCount,
          winRate: obj.winRate,
          lastMentionedAt: obj.lastMentionedAt,
        },
      });
      console.log(`  ✅ Created: "${obj.objectionText.substring(0, 50)}..."`);
    }

    // Upsert responses
    for (const resp of obj.responses) {
      const existingResp = await prisma.objectionResponse.findFirst({
        where: {
          objectionId: objection.id,
          fieldName: resp.fieldName,
        },
      });

      if (existingResp) {
        await prisma.objectionResponse.update({
          where: { id: existingResp.id },
          data: {
            content: resp.content,
            originalContent: resp.content,
          },
        });
      } else {
        await prisma.objectionResponse.create({
          data: {
            objectionId: objection.id,
            fieldName: resp.fieldName,
            content: resp.content,
            originalContent: resp.content,
            status: "auto_generated",
            llmModel: "claude-sonnet-4-20250514",
            llmPromptVersion: "v1-seed",
            version: 1,
          },
        });
      }
    }
  }

  console.log(`\n✅ Seeded ${objections.length} sales objections with responses\n`);
}

seedObjections()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
