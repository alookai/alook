interface AgentRow {
  id: string;
  visibility: string;
  ownerId: string | null;
}

interface AgentAccessRow {
  agentId: string;
  userId: string;
}

export function filterVisibleAgents<T extends AgentRow>(
  allAgents: T[],
  userId: string,
  agentAccessList: AgentAccessRow[],
): T[] {
  const accessSet = new Set(
    agentAccessList.filter((a) => a.userId === userId).map((a) => a.agentId),
  );
  return allAgents.filter(
    (a) => a.visibility === "public" || a.ownerId === userId || accessSet.has(a.id),
  );
}
