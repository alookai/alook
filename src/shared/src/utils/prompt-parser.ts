import { toAlookAddress } from "./email"

export interface PromptAgent {
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

export function parsePromptMentions(prompt: string, agents: PromptAgent[]): ParseResult {
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

    if (m.agent.emailHandle) {
      const replacement = `@${m.agent.name} (${toAlookAddress(m.agent.emailHandle)})`
      result = result.slice(0, m.start) + replacement + result.slice(m.end)
    } else {
      // Preserve canonical casing even without email
      result = result.slice(0, m.start) + `@${m.agent.name}` + result.slice(m.end)
    }
  }

  return { enrichedPrompt: result, mentions }
}
