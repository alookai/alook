import type { Agent, AgentLink } from "@alook/shared"

/**
 * Build the set of agent ids that are "related" to the current agent — i.e.
 * directly linked in either direction. Shared by the textarea mention popup
 * hook and the TipTap composer suggestion so both rank related agents first.
 */
export function relatedAgentIdSet(
  agentLinks: AgentLink[],
  currentAgentId: string,
): Set<string> {
  const ids = new Set<string>()
  for (const link of agentLinks) {
    if (link.source_agent_id === currentAgentId) ids.add(link.target_agent_id)
    if (link.target_agent_id === currentAgentId) ids.add(link.source_agent_id)
  }
  return ids
}

/**
 * Filter a list of agents by a query, ranking name-prefix matches before
 * substring matches. Empty query returns the list untouched (caller slices).
 */
export function filterAgentsByQuery(list: Agent[], query: string): Agent[] {
  if (!query) return list
  const q = query.toLowerCase()
  const startsWith: Agent[] = []
  const includes: Agent[] = []
  for (const a of list) {
    const name = a.name.toLowerCase()
    if (name.startsWith(q)) startsWith.push(a)
    else if (name.includes(q)) includes.push(a)
  }
  return [...startsWith, ...includes]
}

/**
 * Produce the mention-suggestion order: related agents first (query-filtered),
 * then everyone else (query-filtered), capped at `limit` total. This is the
 * grouped order the TipTap composer feeds into its suggestion list.
 */
export function rankMentionAgents(
  agents: Agent[],
  agentLinks: AgentLink[],
  currentAgentId: string,
  query: string,
  limit = 20,
): Agent[] {
  const related = relatedAgentIdSet(agentLinks, currentAgentId)
  const inRelated: Agent[] = []
  const other: Agent[] = []
  for (const a of agents) {
    if (related.has(a.id)) inRelated.push(a)
    else other.push(a)
  }
  return [
    ...filterAgentsByQuery(inRelated, query),
    ...filterAgentsByQuery(other, query),
  ].slice(0, limit)
}
