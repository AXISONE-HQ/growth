# growth Design System — Package

Everything for the growth design system in one folder. Built for AxisOne's growth product (the AI Revenue System).

## Start here

| If you want to… | Open |
|---|---|
| **See it visually** | `design-system/gallery/index.html` (browse the live gallery) |
| **Understand the philosophy** | `design-system/PRINCIPLES.md` (for PMs / stakeholders) |
| **Wire it into the app** | `design-system/README.md` (for engineers) |
| **Look up a component** | `design-system/COMPONENTS.md` (full API per component) |
| **See why decisions were made** | `design-system/DECISIONS.md` (decision log) |
| **Show stakeholders product mockups** | `mockup-onboarding.html` · `mockup-decision-feed.html` · `mockup-brain-status.html` |

## What's in this package

```
outputs/
├── README.md                          ← you are here
│
├── growth-design-system.md            ← v1 spec (kept for reference)
├── mockup-onboarding.html             ← Onboarding flow (5 steps)
├── mockup-decision-feed.html          ← Mission-control home
├── mockup-brain-status.html           ← Living Business Brain view
│
└── design-system/                     ← Full v1 design system
    ├── README.md                      ← Engineering getting started
    ├── PRINCIPLES.md                  ← Philosophy for PMs / stakeholders
    ├── COMPONENTS.md                  ← Component API reference
    ├── DECISIONS.md                   ← Decision log
    │
    ├── tokens.css                     ← CSS custom properties
    ├── tailwind.config.ts             ← Tailwind config (drop-in)
    │
    ├── lib/
    │   ├── tokens.ts                  ← TypeScript tokens (runtime)
    │   ├── cn.ts                      ← classnames helper
    │   └── confidence.ts              ← getConfidenceVariant + helpers
    │
    ├── components/
    │   ├── ui/                        ← 18 themed primitives
    │   │   ├── button.tsx · input.tsx · textarea.tsx · select.tsx
    │   │   ├── switch.tsx · checkbox.tsx · radio-group.tsx
    │   │   ├── dialog.tsx · sheet.tsx · tabs.tsx · tooltip.tsx · dropdown-menu.tsx
    │   │   ├── avatar.tsx · badge.tsx · card.tsx · label.tsx · separator.tsx · toast.tsx
    │   ├── growth/                    ← 10 AI-aware components
    │   │   ├── confidence-badge.tsx · ai-action-card.tsx · reasoning-panel.tsx
    │   │   ├── escalation-alert.tsx · brain-layer-card.tsx
    │   │   ├── objective-gap-tracker.tsx · ai-status-indicator.tsx
    │   │   ├── metric-strip.tsx · permission-toggle.tsx · decision-feed-row.tsx
    │   ├── layout/                    ← Shell, Sidebar, Topbar
    │   ├── charts/                    ← ProgressRing, Sparkline, LineChart, BarChart
    │   ├── data-table/                ← DataTable
    │   ├── forms/                     ← FormField, FormSection
    │   └── command/                   ← CommandPalette
    │
    └── gallery/                       ← Live HTML gallery
        ├── index.html                 ← Landing
        ├── foundations.html           ← Color, type, spacing, motion
        ├── primitives.html            ← All 18 primitives
        ├── growth.html                ← All 10 growth components
        ├── advanced.html              ← Charts, table, command palette
        ├── patterns.html              ← Composed examples
        └── _shared.css                ← Gallery shared styles
```

## File counts

- **3** product mockups (HTML)
- **6** gallery pages (HTML + 1 shared CSS)
- **35+** TSX component files (production-ready React)
- **5** library files (tokens.css, tailwind.config.ts, 3× lib/)
- **5** documentation files (this README + 4 in design-system/)

## Stack

React 18 · Next.js 14+ App Router · TypeScript · Tailwind CSS · shadcn/ui (Radix UI) · Recharts · TanStack Table · cmdk · lucide-react.

## Key decisions made along the way

(See `design-system/DECISIONS.md` for the full list with reasoning.)

- **Light-first theme** (dark mode v2) — matches HubSpot/Salesforce mental model
- **Strict AxisOne master brand** — future products inherit unchanged
- **Direction B (Living intelligence) palette** — warm off-white + plum-ink + violet primary + emerald accent
- **Confidence as a first-class visual concept** — 4 bands, color always paired with text
- **shadcn/ui as primitive layer** — Radix accessibility + custom theming
- **Inter + JetBrains Mono** — open-source, swap-ready when AxisOne licenses a face
- **Two font weights only (400, 500)** — heavier weights look wrong on warm off-white
- **Borders, not shadows** — crisper, calmer, more "ops tool" than "consumer app"
- **Verb + object button labels** — always
- **Reasoning panel is always available** — collapsed by default
- **Decision Feed as the home page** — not a generic dashboard
- **Validation, not configuration** — onboarding is 5 questions, not a wizard
- **Mobile is read-only for configuration** — admin work happens on desktop

## License + ownership

This design system is internal to AxisOne. Components compose shadcn/ui (MIT licensed) and Radix UI (MIT licensed) primitives.

---

_v1.0 · May 5, 2026 · AxisOne Design_
