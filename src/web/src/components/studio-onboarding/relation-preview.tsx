"use client";

import type { TeamMember } from "./team-preview";

const ROLE_VERBS: Record<string, string> = {
  researcher: "research and context gathering",
  engineer: "code changes and verification",
  assistant: "follow-ups and task tracking",
};

export function RelationPreview({ members }: { members: TeamMember[] }) {
  const leader = members.find((m) => m.role === "leader");
  const specialists = members.filter((m) => m.role !== "leader");

  if (!leader || specialists.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium">Team collaboration</h2>
      <div className="rounded-lg border border-border p-4 space-y-2">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{leader.name}</span> leads the studio and coordinates the team.
        </p>
        {specialists.map((s, i) => (
          <p key={i} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{s.name}</span> helps {leader.name} with {ROLE_VERBS[s.role] || s.description}.
          </p>
        ))}
      </div>
    </div>
  );
}
