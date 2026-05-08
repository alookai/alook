"use client";

import type { TeamMember } from "./team-preview";

const ROLE_RELATIONS: Record<string, { receives: string; reports: string }> = {
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
};

export function RelationPreview({ members }: { members: TeamMember[] }) {
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
        {specialists.map((s, i) => (
          <div key={i} className="text-xs text-muted-foreground space-y-0.5">
            <p>
              <span className="font-medium text-foreground">{leader.name}</span>
              {" → "}
              <span className="font-medium text-foreground">{s.name}</span>
              {": "}
              {ROLE_RELATIONS[s.role]?.receives || s.description}
            </p>
            <p>
              <span className="font-medium text-foreground">{s.name}</span>
              {" → "}
              <span className="font-medium text-foreground">{leader.name}</span>
              {": "}
              {ROLE_RELATIONS[s.role]?.reports || "results and status updates"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
