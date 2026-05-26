import type { TemplatePreset } from "../types";

export const weeklyReportBot: TemplatePreset = {
  id: "weekly-report-bot",
  name: "Weekly Report Bot",
  category: "Freelancer",
  icon: "📊",
  description: "Summarize your week's work from git, emails, and calendar into a structured report delivered to your inbox.",
  longDescription:
    "End every week with a clear picture of what happened. Your researcher gathers data from your work streams — git commits, emails sent/received, and calendar events — then your leader synthesizes everything into a structured weekly report. Great for freelancers tracking time, managers needing team summaries, or anyone who wants to reflect on their productivity.",
  tags: ["reports", "productivity", "summary", "weekly review"],
  features: [
    "Git activity summarization (commits, PRs, reviews)",
    "Email communication summary (key threads, outstanding items)",
    "Calendar event recap and time allocation analysis",
    "Weekly highlight and accomplishment extraction",
    "Blocker and carry-over identification",
    "Automated report delivery every Friday via email",
  ],
  useCases: [
    { title: "Freelancers", description: "Track your billable work and create client-ready activity reports effortlessly." },
    { title: "Remote workers", description: "Keep your manager informed with structured weekly updates without the Friday scramble." },
    { title: "Team leads", description: "Generate team activity summaries for standups and stakeholder updates." },
  ],
  baseScenario: "content-research",
  members: [
    {
      role: "leader",
      description: "Synthesizes activity data into a structured weekly report",
      instructions: `You are the report coordinator. You turn raw activity data into a clear, insightful weekly summary.

## Principles
- Report structure: Highlights (top 3-5 wins), Work completed (by project), In progress, Blockers (with next steps), Next week priorities, Time allocation.
- Keep the full report readable in 2-3 minutes. Be honest — don't inflate or hide unproductive stretches.
- Note patterns: if something keeps appearing in "blockers" week over week, call it out explicitly.
- Deliver the final report via email every Friday.
- Blockers must include suggested next steps — not just what's stuck, but what to try.`,
    },
    {
      role: "researcher",
      description: "Gathers activity data from git, emails, and calendar",
      instructions: `You are the activity data gatherer. You collect raw information about the user's week from various sources.

## Principles
- Git: group commits by project/feature, note significant changes vs. minor fixes. Summarize PRs opened/merged/reviewed.
- Email: focus on decision-bearing threads, not noise. Track important decisions and outstanding items.
- Calendar: note meeting purposes (not just titles), total meeting time, productive vs. overhead estimate.
- Include: feature work, bug fixes, reviews, important decisions, client comms. Exclude: automated notifications, spam.
- Flag data gaps (e.g., calendar empty on a day — PTO or just no meetings?). Highlight completed milestones.`,
      relationship: {
        leaderSees: "Delegate data gathering with: time range, sources to check (git, email, calendar), and focus areas or projects to highlight.",
        memberSees: "Report back with: raw activity data organized by source, milestones completed, data gaps flagged, and items needing interpretation.",
      },
    },
  ],
};
