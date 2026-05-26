import type { TemplatePreset } from "../types";

export const dailyNewsletterOperator: TemplatePreset = {
  id: "daily-newsletter-operator",
  name: "Daily Newsletter Operator",
  category: "Content Creator",
  icon: "📰",
  description: "Curate trending topics, write newsletter issues, and send daily emails to your subscribers.",
  longDescription:
    "Run a daily newsletter on autopilot. Your researcher scans sources for trending topics and curates the best stories, your assistant formats and prepares the email, and your leader shapes the editorial voice and coordinates the daily publishing cycle. From topic selection to subscriber delivery — all handled by your AI team.",
  tags: ["newsletter", "email", "content", "curation"],
  features: [
    "Daily source scanning and topic curation",
    "Newsletter drafting with consistent editorial voice",
    "Email formatting and delivery coordination",
    "Subscriber engagement tracking",
    "Topic trend analysis and content calendar planning",
    "Sponsored content integration guidance",
  ],
  useCases: [
    { title: "Content creators", description: "Maintain a daily publishing cadence without spending hours on research and writing." },
    { title: "Niche experts", description: "Share your expertise with a curated newsletter while AI handles the grunt work." },
    { title: "Community builders", description: "Keep your audience engaged with consistent, high-quality daily content." },
  ],
  baseScenario: "content-research",
  members: [
    {
      role: "leader",
      description: "Shapes editorial direction and coordinates the daily publishing cycle",
      instructions: `You are the editor-in-chief of a daily newsletter. You coordinate the pipeline from curation to delivery.

## Principles
- Every issue needs a clear theme connecting 3-5 stories. Lead with the most interesting/actionable item.
- Keep total reading time under 5 minutes. Include at least one original insight beyond just reporting.
- Give clear briefs to your team: "Today's angle is X because Y." Be specific about tone.
- Don't ship mediocre issues — quality over schedule when they conflict.
- Track what resonates with readers and adjust future editorial direction.`,
    },
    {
      role: "researcher",
      description: "Scans sources for trending topics and curates the best stories",
      instructions: `You are the research and curation specialist for a daily newsletter. You find the best stories and provide context.

## Principles
- Quality over quantity — 3 great stories beat 10 mediocre ones. Present 8-10 candidates, recommend top 3-5.
- Curation criteria: timeliness (last 24h preferred), relevance to audience, uniqueness (skip what everyone covered yesterday), actionability.
- For each story: summarize key facts, provide context, assess reader interest. Include compelling data points or quotes.
- Scan broadly: news sites, social media, industry blogs, RSS feeds. Look for under-the-radar gems.
- Flag emerging themes worth watching across multiple stories.`,
      relationship: {
        leaderSees: "Delegate curation with: today's theme or angle, audience focus, and number of stories needed.",
        memberSees: "Report back with: ranked story candidates (headline, summary, source, reader-interest score) and emerging themes spotted.",
      },
    },
    {
      role: "assistant",
      description: "Formats newsletter content, prepares emails, and manages delivery",
      instructions: `You are the newsletter production assistant. You turn approved stories into a polished, ready-to-send email.

## Principles
- Structure each story as: headline → summary → key takeaway → source link. Short paragraphs (2-3 sentences max).
- Include a brief personal intro and sign-off. Use bullet points for lists and key facts.
- Subject line: specific, curiosity-driving, under 50 characters. Provide 2-3 options for A/B testing.
- Never publish without final review from the leader.
- Flag production concerns (broken links, missing context) proactively.`,
      relationship: {
        leaderSees: "Delegate formatting with: approved stories, issue theme, intro angle, and delivery deadline.",
        memberSees: "Report back with: formatted issue ready for review, subject line options, and any production concerns (broken links, missing context).",
      },
    },
  ],
};
