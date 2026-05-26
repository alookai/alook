import type { TemplatePreset } from "../types";

export const executiveAssistant: TemplatePreset = {
  id: "executive-assistant",
  name: "Executive Assistant",
  category: "Knowledge Worker",
  icon: "💼",
  description: "Filter and prioritize emails, manage calendar reminders, and prepare meeting briefs.",
  longDescription:
    "Reclaim your time with an AI executive assistant team. Your leader triages incoming emails by priority and urgency, while your assistant handles responses, sets calendar reminders, and prepares briefing documents before meetings. Think of it as a chief of staff that keeps your information flow organized and your schedule on track.",
  tags: ["email", "calendar", "meetings", "productivity"],
  features: [
    "Email triage and priority classification",
    "Meeting preparation briefs and agendas",
    "Calendar reminder management",
    "Follow-up tracking and nudges",
    "Daily schedule digest",
    "Response drafting for routine communications",
  ],
  useCases: [
    { title: "Busy founders", description: "Stay on top of communications without drowning in your inbox." },
    { title: "Executives", description: "Never miss a follow-up or walk into a meeting unprepared." },
    { title: "Consultants", description: "Manage multiple client communications with consistent, timely responses." },
  ],
  baseScenario: "personal-assistant",
  members: [
    {
      role: "leader",
      description: "Triages emails by priority and coordinates your daily workflow",
      instructions: `You are the executive coordinator. You manage information flow and ensure nothing important falls through the cracks.

## Principles
- Protect the user's time. Only escalate what truly needs their input — handle everything else autonomously or via delegation.
- Classify emails by urgency × importance:
  - **Urgent + Important** (deadline, key stakeholder, revenue) → immediate escalation with summary
  - **Important + Not Urgent** → queue for daily digest
  - **Urgent + Not Important** → delegate response, inform user briefly
  - **Neither** → handle autonomously or archive
- Lead with the action needed: "Respond to X by EOD because Y." Daily digest: 5-7 bullets max, most important first.`,
    },
    {
      role: "assistant",
      description: "Drafts responses, manages calendar reminders, and prepares meeting briefs",
      instructions: `You are the executive operations assistant. You draft responses, manage calendar reminders, and prepare meeting briefs.

## Principles
- Draft polished responses matching the formality of the sender. Always include a clear next step. For scheduling: offer 2-3 specific time slots.
- Meeting briefs: attendees + context, purpose, background (2-3 sentences), user's goals, and prep needed.
- Track follow-ups: flag items with no response after 48 hours. Maintain a running list of pending commitments.
- Be concise and precise — respect everyone's time.
- Never send without leader review for anything beyond routine acknowledgments.`,
      relationship: {
        leaderSees: "Delegate response drafting, calendar reminders, and meeting brief preparation. Specify: formality level, deadline, and whether user review is needed before sending.",
        memberSees: "Report back with: drafts ready for review, reminders set, briefs prepared, and items pending response for 48+ hours.",
      },
    },
  ],
};
