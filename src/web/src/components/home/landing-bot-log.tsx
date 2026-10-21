"use client"

import type { AuditEvent } from "@/hooks/community/use-bot-audit-log"
import type { Marked } from "@/lib/community/models/inbox"
import { BotMarkStickerView } from "@/components/community/social/bot-mark-sticker"
import { DEMO_CHANNELS, DEMO_MESSAGES, DEMO_PROFILES, DEMO_SERVERS } from "./landing-interactive-shell-data"

const work: Record<string, { thoughts: string[]; marks: [string, number][] }> = {
  "demo-alli": {
    thoughts: ["Reviewing H2 at the smaller type size. The room list and composer need to stay readable together.", "The profile and Bot log should stay connected when the screen gets narrow.", "Keeping the original product story below the interactive room."],
    marks: [["demo-design-review", 0], ["demo-general", 1]],
  },
  "demo-cecilia": {
    thoughts: ["Checking the H2 phone composer after switching rooms and opening a profile.", "The reported height issue is fixed. Gus still needs to complete the final phone flow.", "Coffee Map C2 keeps the second entry empty and prevents duplicate saves."],
    marks: [["demo-release-room", 2], ["demo-feedback", 0]],
  },
  "demo-claudette": {
    thoughts: ["Comparing H2’s design decisions with the candidate in release-room.", "Desktop behavior passed. Keeping the real-phone check separate from that result.", "Checking that each handoff names the same version and next action."],
    marks: [["demo-release-room", 0], ["demo-web-bugs", 1]],
  },
  "demo-evan": {
    thoughts: ["Checking the source arrow beside each quote author.", "Long quotes stay within three lines; their source links retain the complete post.", "Reviewing the moving rows with reduced motion enabled."],
    marks: [["demo-content", 2], ["demo-dm-evan", 1]],
  },
  "demo-devin": {
    thoughts: ["Cross-checking Maya’s comparison against the three internal Coffee Map sketches.", "The recommendation is about our sketches, not a claim about competing products.", "Preparing the first trial question: what did you expect after Save?"],
    marks: [["demo-research-notes", 1], ["demo-launch-plan", 1]],
  },
  "demo-maya": {
    thoughts: ["Reviewing Shelly’s List-first walkthrough alongside the other two sketches.", "The saved note needs to remain easy to find when a second café is added.", "Keeping the next trial questions in the shared project room for Tracy."],
    marks: [["demo-inspiration", 2], ["demo-launch-plan", 4]],
  },
}

export const DEMO_BOT_LOGS = Object.fromEntries(Object.entries(work).map(([id, item]) => {
  const events: AuditEvent[] = item.thoughts.map((text, index) => ({
    id: `${id}-thought-${index}`, kind: "text", payload: { text, truncated: false, chars: text.length },
    sessionId: null, launchId: null, createdAt: `2026-10-21T06:${55 + index}:00.000Z`,
  }))
  const marks: Marked[] = item.marks.map(([channelId, index]) => {
    const server = DEMO_SERVERS.find((server) => DEMO_CHANNELS[server.id].some((group) => group.channels.some((channel) => channel.id === channelId)))
    const channel = server ? DEMO_CHANNELS[server.id].flatMap((group) => group.channels).find((channel) => channel.id === channelId) : undefined
    const source = DEMO_MESSAGES[channelId][index]
    const author = DEMO_PROFILES.get(source.authorId!)
    const m = { ...source, authorName: author?.name, authorAvatar: author?.avatar ?? undefined }
    return { id: `${id}-mark-${m.id}`, server: server?.name ?? "DM", serverId: server?.id ?? null, channel: channel?.name ?? "Gus", channelId, m }
  })
  return [id, { events, marks }]
}))

export function LandingBotLog({ botId }: { botId: string }) {
  const log = DEMO_BOT_LOGS[botId]
  if (!log) return null
  return <BotMarkStickerView active showStop={false} stopPending={false} onStop={() => {}}
    activity={{ events: log.events, isLoading: false, isError: false, isNotFound: false }} marks={log.marks} isLoading={false} isError={false} />
}
