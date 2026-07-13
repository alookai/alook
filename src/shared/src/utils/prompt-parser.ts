import { toAlookAddress } from "./email"
import { MENTION_TOKEN_RE } from "./mention-token"

export interface PromptAgent {
  id: string
  name: string
  emailHandle: string | null
  description: string
}

export interface PromptMention {
  name: string
  email: string | null
  description: string
}

export interface ParseResult {
  enrichedPrompt: string
  mentions: PromptMention[]
}

function isTrigger(prompt: string, atIndex: number): boolean {
  if (atIndex === 0) return true
  const prev = prompt.charCodeAt(atIndex - 1)
  // Valid trigger if preceded by a non-alphanumeric/non-underscore character
  if ((prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95) return false
  return true
}

function isBoundary(prompt: string, endIndex: number): boolean {
  if (endIndex >= prompt.length) return true
  const next = prompt.charCodeAt(endIndex)
  if ((next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95) return false
  return true
}

function enrichMention(name: string, emailHandle: string | null): string {
  return emailHandle ? `@${name} (${toAlookAddress(emailHandle)})` : `@${name}`
}

function parseBareNames(prompt: string, agents: PromptAgent[]): ParseResult {
  if (!prompt || agents.length === 0) return { enrichedPrompt: prompt, mentions: [] }

  const sorted = agents.slice().sort((a, b) => b.name.length - a.name.length)
  const mentions: PromptMention[] = []

  interface Match {
    start: number
    end: number
    agent: PromptAgent
  }

  const matches: Match[] = []

  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i] !== "@") continue
    if (!isTrigger(prompt, i)) continue

    const afterAt = i + 1
    for (const agent of sorted) {
      const nameEnd = afterAt + agent.name.length
      if (nameEnd > prompt.length) continue
      const slice = prompt.slice(afterAt, nameEnd)
      if (slice.toLowerCase() !== agent.name.toLowerCase()) continue
      if (!isBoundary(prompt, nameEnd)) continue

      // Check this match doesn't overlap with a previously found match
      const overlaps = matches.some(m => i >= m.start && i < m.end)
      if (overlaps) break

      matches.push({ start: i, end: nameEnd, agent })
      break
    }
  }

  // Process from end to start to preserve offsets
  let result = prompt
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const mention: PromptMention = {
      name: m.agent.name,
      email: m.agent.emailHandle ? toAlookAddress(m.agent.emailHandle) : null,
      description: m.agent.description,
    }
    mentions.unshift(mention)
    result = result.slice(0, m.start) + enrichMention(m.agent.name, m.agent.emailHandle) + result.slice(m.end)
  }

  return { enrichedPrompt: result, mentions }
}

export function parsePromptMentions(prompt: string, agents: PromptAgent[]): ParseResult {
  if (!prompt) return { enrichedPrompt: prompt, mentions: [] }

  // Token pass — `@[Name](agentId)` resolves the exact agent by id. Runs even
  // when the agents list is empty so a raw token is never leaked into the
  // enriched prompt sent to the runtime; an unmatched token (agent deleted) is
  // stripped back to `@Name`. Text between tokens keeps the bare-name matching
  // for backward compatibility with historic / externally-sourced mentions.
  const byId = new Map(agents.map(a => [a.id, a]))
  const re = new RegExp(MENTION_TOKEN_RE.source, "g")
  const mentions: PromptMention[] = []
  let result = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(prompt)) !== null) {
    const between = parseBareNames(prompt.slice(last, m.index), agents)
    result += between.enrichedPrompt
    mentions.push(...between.mentions)

    const label = m[1]
    const agent = byId.get(m[2])
    if (agent) {
      result += enrichMention(agent.name, agent.emailHandle)
      mentions.push({
        name: agent.name,
        email: agent.emailHandle ? toAlookAddress(agent.emailHandle) : null,
        description: agent.description,
      })
    } else {
      result += `@${label}`
    }
    last = re.lastIndex
  }

  const tail = parseBareNames(prompt.slice(last), agents)
  result += tail.enrichedPrompt
  mentions.push(...tail.mentions)

  return { enrichedPrompt: result, mentions }
}
