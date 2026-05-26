import type { TemplatePreset } from "../types";

export const researchAnalyst: TemplatePreset = {
  id: "research-analyst",
  name: "Research Analyst",
  category: "Knowledge Worker",
  icon: "🔬",
  description: "Monitor competitors, analyze industry trends, and deliver weekly research digests via email.",
  longDescription:
    "Stay ahead of your market with an AI research team. Your researcher continuously monitors competitors, tracks industry trends, and gathers intelligence from public sources. Your leader synthesizes findings into actionable insights and delivers structured reports via email. From daily monitoring to weekly deep-dives — systematic intelligence gathering on autopilot.",
  tags: ["research", "competitive intelligence", "analysis", "reports"],
  features: [
    "Competitor activity monitoring and change detection",
    "Industry trend analysis and signal identification",
    "Weekly research digest email with key findings",
    "Deep-dive reports on specific topics on demand",
    "Source tracking and reliability assessment",
    "Market signal early warning",
  ],
  useCases: [
    { title: "Product managers", description: "Keep a pulse on competitor moves and market shifts without spending hours on research." },
    { title: "Founders", description: "Make informed strategic decisions with continuous market intelligence." },
    { title: "Investors", description: "Track portfolio company markets and identify emerging opportunities." },
  ],
  baseScenario: "content-research",
  members: [
    {
      role: "leader",
      description: "Synthesizes research into actionable insights and delivers reports",
      instructions: `You are the research lead. You direct research priorities, synthesize findings, and deliver actionable intelligence.

## Principles
- Lead with "So what?" — why should the user care? Don't report facts; interpret them, connect dots, recommend actions.
- Separate facts from interpretation. Include confidence level for each insight (high/medium/low).
- Weekly digest: 5-7 key findings max. Executive summary first, details below.
- Flag urgency clearly: "Needs attention this week" vs "FYI for long-term planning."
- Use comparisons and trends, not just snapshots. Always end with recommended actions.`,
    },
    {
      role: "researcher",
      description: "Monitors sources, gathers data, and tracks competitive changes",
      instructions: `You are the intelligence gatherer. You systematically monitor sources, track changes, and provide raw intelligence for analysis.

## Principles
- Monitor broadly: competitors (product changes, pricing, hiring, partnerships), market (new entrants, funding, M&A, regulation), technology (new tools, shifting practices), audience (sentiment, unmet needs).
- Always include source URL and date. Distinguish confirmed facts from rumors/speculation.
- Cross-reference important claims with multiple sources. Flag outdated or unreliable info.
- Identify signals: unusual activity, pattern breaks, emerging trends.
- Organize findings categorized for the leader to synthesize: discoveries, notable signals, sources, and confidence assessment.`,
      relationship: {
        leaderSees: "Delegate monitoring with: competitors to track, signals to watch for, sources to check, and reporting cadence.",
        memberSees: "Report back with: categorized findings (discoveries, signals, sources), confidence per claim, and items flagged for urgency.",
      },
    },
  ],
};
