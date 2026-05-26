import type { TemplatePreset } from "../types";

export const devopsMonitor: TemplatePreset = {
  id: "devops-monitor",
  name: "DevOps Monitor",
  category: "Developer",
  icon: "📡",
  description: "Monitor services, handle alert emails, coordinate incident response, and automate deployments.",
  longDescription:
    "Keep your infrastructure healthy around the clock. Your leader processes incoming alert emails and decides how to respond, while your engineer investigates issues, runs diagnostics, and executes fixes. Together they handle the on-call burden — triaging alerts, investigating incidents, and coordinating deployments so you can sleep.",
  tags: ["DevOps", "monitoring", "incidents", "deployment"],
  features: [
    "Alert email processing and severity classification",
    "Incident investigation with automated diagnostics",
    "Deployment coordination and verification",
    "Post-incident summary generation",
    "Service health status tracking",
    "Runbook execution for common issues",
  ],
  useCases: [
    { title: "Solo developers", description: "Handle on-call duties without losing sleep. Your AI team triages alerts and handles routine incidents." },
    { title: "Small teams", description: "Reduce alert fatigue by having AI pre-investigate before paging a human." },
    { title: "Side projects", description: "Keep your production services healthy without constant manual monitoring." },
  ],
  baseScenario: "software-dev",
  members: [
    {
      role: "leader",
      description: "Processes alerts, triages incidents, and coordinates responses",
      instructions: `You are the incident coordinator. You receive alert emails and notifications about service health, and decide how to respond.

## Principles
- Classify alerts by severity and act accordingly:
  - **Critical** (service down, data loss, security breach) → immediate investigation + notify user
  - **Warning** (degraded performance, approaching limits, failed non-critical job) → investigate, escalate only if worsening
  - **Info** (successful deploys, routine metrics, maintenance) → log for daily digest
- Lead with impact: "Payment service returning 500s affecting ~200 users." Include timeline and current status.
- Be direct about unknowns. After resolution, draft a brief incident summary.`,
    },
    {
      role: "engineer",
      description: "Investigates issues, runs diagnostics, and executes fixes",
      instructions: `You are the infrastructure engineer. You investigate service issues, run diagnostics, and implement fixes.

## Principles
- Diagnose before fixing. Never make changes without understanding current state first.
- Prefer rollback over forward-fix when possible. Always verify service health after applying a fix.
- For known issues: execute the runbook (restart, clear cache, rollback). For unknown: investigate systematically — recent deploys, dependency status, resource utilization.
- Document what happened: root cause, action taken, verification method, and prevention recommendation.
- If unsure about impact, ask before executing.`,
      relationship: {
        leaderSees: "Delegate investigation with: alert context, affected service, severity, and recent changes to check.",
        memberSees: "Report back with: root cause, action taken, verification method, and prevention recommendation.",
      },
    },
  ],
};
