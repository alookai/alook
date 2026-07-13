import type { Agent } from "@alook/shared"
import { MENTION_TOKEN_RE } from "@alook/shared"

function isTrigger(text: string, atIndex: number): boolean {
  if (atIndex === 0) return true
  const prev = text.charCodeAt(atIndex - 1)
  if ((prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95) return false
  return true
}

function isBoundary(text: string, endIndex: number): boolean {
  if (endIndex >= text.length) return true
  const next = text.charCodeAt(endIndex)
  if ((next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95) return false
  return true
}

export function highlightMentions(content: string, agents: Agent[]): string {
  if (!content || !content.includes("@")) return content

  // Token pass — id-based, independent of the agents array so a raw
  // `@[Name](agentId)` token never survives into <Streamdown> (where it would
  // render as a markdown link to the id). Text between tokens still runs
  // through the bare-name pass for backward compatibility with historic /
  // externally-sourced `@Name` mentions.
  const re = new RegExp(MENTION_TOKEN_RE.source, "g")
  let result = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    result += highlightBareNames(content.slice(last, m.index), agents)
    result += `<mention data-agent-id="${m[2]}">@${m[1]}</mention>`
    last = re.lastIndex
  }
  result += highlightBareNames(content.slice(last), agents)
  return result
}

function highlightBareNames(content: string, agents: Agent[]): string {
  if (!content || agents.length === 0 || !content.includes("@")) return content

  const sorted = agents.slice().sort((a, b) => b.name.length - a.name.length)

  interface Match {
    start: number
    end: number
    name: string
    agentId: string
  }

  const matches: Match[] = []

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@") continue
    if (!isTrigger(content, i)) continue

    const afterAt = i + 1
    for (const agent of sorted) {
      const nameEnd = afterAt + agent.name.length
      if (nameEnd > content.length) continue
      const slice = content.slice(afterAt, nameEnd)
      if (slice.toLowerCase() !== agent.name.toLowerCase()) continue

      // Check if this is the enriched form: @AgentName (handle@alook.ai)
      let matchEnd = nameEnd
      const afterName = content.slice(nameEnd)
      const enrichedMatch = afterName.match(/^ \([a-zA-Z0-9-]+@alook\.ai\)/)
      if (enrichedMatch) {
        matchEnd = nameEnd + enrichedMatch[0].length
      }

      if (!enrichedMatch && !isBoundary(content, nameEnd)) continue
      if (enrichedMatch && !isBoundary(content, matchEnd)) continue

      const overlaps = matches.some(m => i >= m.start && i < m.end)
      if (overlaps) break

      matches.push({ start: i, end: nameEnd, name: agent.name, agentId: agent.id })
      break
    }
  }

  // Process from end to start
  let result = content
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const name = result.slice(m.start, m.end)
    result = result.slice(0, m.start) + `<mention data-agent-id="${m.agentId}">${name}</mention>` + result.slice(m.end)
  }

  return result
}
