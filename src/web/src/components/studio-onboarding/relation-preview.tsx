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
  productivity: {
    assistant: {
      receives: "actions with targets, deadlines, and tone guidance",
      reports: "completion status with next steps and escalation flags",
    },
  },
  "full-team": {
    researcher: {
      receives: "research briefs with clear questions and scope",
      reports: "structured findings with sources and confidence levels",
    },
    engineer: {
      receives: "coding tasks with requirements and context",
      reports: "verified code changes with test results and self-review",
    },
    assistant: {
      receives: "operational tasks with actions, targets, and deadlines",
      reports: "completion status with next steps and escalation flags",
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
      <h2 className="text-sm font-medium">Team collaboration</h2>
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
