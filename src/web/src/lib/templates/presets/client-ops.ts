import type { TemplatePreset } from "../types";

export const clientOps: TemplatePreset = {
  id: "client-ops",
  name: "Client Ops",
  category: "Freelancer",
  icon: "🤝",
  description: "Auto-reply to client inquiries, schedule meetings, send follow-ups, and manage project communications.",
  longDescription:
    "Never miss a client email again. Your leader manages client relationships and prioritizes communications, while your assistant drafts professional responses, schedules meetings, and sends timely follow-ups. Perfect for freelancers and consultants who want to appear responsive and organized without being glued to their inbox all day.",
  tags: ["clients", "freelance", "email", "scheduling"],
  features: [
    "Automatic acknowledgment of new client inquiries",
    "Professional response drafting for common questions",
    "Meeting scheduling with availability coordination",
    "Follow-up reminders for pending proposals and invoices",
    "Project update email drafting",
    "Client onboarding email sequence",
  ],
  useCases: [
    { title: "Freelancers", description: "Look professional and responsive while focusing on actual client work." },
    { title: "Consultants", description: "Manage multiple client relationships without dropping any balls." },
    { title: "Small agencies", description: "Scale client communications without hiring a dedicated account manager." },
  ],
  baseScenario: "personal-assistant",
  members: [
    {
      role: "leader",
      description: "Manages client relationships and prioritizes communications",
      instructions: `You are the client relationship coordinator. You ensure every client feels taken care of and nothing falls through the cracks.

## Principles
- Never leave a client waiting: acknowledge every email within 4 hours (even just "received, will respond by X").
- Follow-up timing: proposals → 3 days, invoices → 7, 14, 30 days. Proactive weekly project updates.
- Escalate to user: pricing discussions, scope changes, complaints, payment issues (>30 days overdue), and new inquiries needing custom responses.
- Classify incoming emails by client, urgency, and type (inquiry, feedback, request, payment). Route to assistant for drafting.
- Build trust through consistency. Professional communication retains business.`,
    },
    {
      role: "assistant",
      description: "Drafts responses, schedules meetings, and sends follow-ups",
      instructions: `You are the client operations assistant. You draft responses, schedule meetings, and manage follow-ups.

## Principles
- Professional but warm tone — not corporate-stiff, not overly casual. Every email should make the client feel valued.
- Always include a clear next step or timeline. For scheduling: offer 3 specific time options.
- For follow-ups: be helpful, not pushy — "Checking in on X, let me know if you need anything."
- For updates: lead with progress, then next steps, then blockers.
- Set calendar reminders for all follow-up actions. Never let a commitment drop silently.`,
      relationship: {
        leaderSees: "Delegate client communications with: client name, email type (acknowledgment, update, follow-up, scheduling), urgency, and tone.",
        memberSees: "Report back with: draft ready for review, meetings scheduled, reminders set, and follow-ups due.",
      },
    },
  ],
};
