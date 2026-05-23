"use client";

import type { ScenarioId } from "./scenario-presets";
import type { TeamMember } from "./team-preview";

type RelationText = { receives: string; reports: string };

const SCENARIO_RELATIONS: Record<string, Record<string, RelationText>> = {
  "software-dev": {
    researcher: {
      receives: "technical research tasks (APIs, libraries, architecture)",
      reports: "findings with code references and confidence levels",
    },
    engineer: {
      receives: "coding tasks with file paths and patterns to follow",
      reports: "verified changes with test results and self-review",
    },
  },
  "content-research": {
    researcher: {
      receives: "topics to investigate, claims to verify, sources to check",
      reports: "verified facts with source list and per-claim confidence",
    },
    assistant: {
      receives: "content to format/publish with platform and deadline",
      reports: "publication status and next steps",
    },
  },
  "sales-outreach": {
    researcher: {
      receives: "prospect research tasks with target criteria and market focus",
      reports: "actionable intelligence with prospect lists and confidence levels",
    },
    assistant: {
      receives: "outreach tasks with prospect details, messaging angle, and timeline",
      reports: "outreach status with responses received and follow-up schedule",
    },
  },
  "customer-support": {
    assistant: {
      receives: "support tickets with customer context and urgency level",
      reports: "resolution status with customer response and follow-up needs",
    },
  },
};

function getRelation(scenario: ScenarioId | undefined, role: string): RelationText {
  if (scenario && SCENARIO_RELATIONS[scenario]?.[role]) {
    return SCENARIO_RELATIONS[scenario][role];
  }
  return { receives: "delegated tasks with context", reports: "results with status updates" };
}

export function RelationPreview({ members, scenario }: { members: TeamMember[]; scenario?: ScenarioId }) {
  const leader = members.find((m) => m.role === "leader");
  const specialists = members.filter((m) => m.role !== "leader");

  if (!leader || specialists.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight">How they work together</h2>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          You email <span className="font-medium text-foreground">{leader.name}</span> with tasks.{" "}
          {leader.name} handles them directly or delegates to specialists.
        </p>
        {specialists.map((s, i) => {
          const rel = getRelation(scenario, s.role);
          return (
            <div key={i} className="text-xs text-muted-foreground space-y-0.5">
              <p>
                <span className="font-medium text-foreground">{leader.name}</span>
                {" → "}
                <span className="font-medium text-foreground">{s.name}</span>
                {": "}
                {rel.receives}
              </p>
              <p>
                <span className="font-medium text-foreground">{s.name}</span>
                {" → "}
                <span className="font-medium text-foreground">{leader.name}</span>
                {": "}
                {rel.reports}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
