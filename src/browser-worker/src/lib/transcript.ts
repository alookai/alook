import type { RawCaption } from "./caption-scraper"

export interface TranscriptEntry {
  speaker: string
  text: string
  timestamp: string
}

export interface TranscriptBlock {
  speaker: string
  lines: string[]
  startTimestamp: string
}

export function createTimestamp(startMs: number, currentMs: number): string {
  const elapsed = Math.max(0, currentMs - startMs)
  const totalSeconds = Math.floor(elapsed / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function deduplicateCaptions(
  existing: TranscriptEntry[],
  incoming: RawCaption[],
  meetingStartMs: number,
  nowMs: number,
): TranscriptEntry[] {
  const timestamp = createTimestamp(meetingStartMs, nowMs)
  const newEntries: TranscriptEntry[] = []

  for (const cap of incoming) {
    const last = existing.length > 0 ? existing[existing.length - 1] : null

    if (last && last.speaker === cap.speaker && last.text === cap.text) {
      continue
    }

    if (last && last.speaker === cap.speaker && cap.text.startsWith(last.text)) {
      last.text = cap.text
      continue
    }

    newEntries.push({
      speaker: cap.speaker,
      text: cap.text,
      timestamp,
    })
  }

  return [...existing, ...newEntries]
}

export function groupIntoBlocks(entries: TranscriptEntry[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []

  for (const entry of entries) {
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null

    if (lastBlock && lastBlock.speaker === entry.speaker) {
      lastBlock.lines.push(entry.text)
    } else {
      blocks.push({
        speaker: entry.speaker,
        lines: [entry.text],
        startTimestamp: entry.timestamp,
      })
    }
  }

  return blocks
}

export function formatTranscript(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return ""

  const blocks = groupIntoBlocks(entries)

  return blocks
    .map((block) => `[${block.startTimestamp}] ${block.speaker}:\n${block.lines.join("\n")}`)
    .join("\n\n")
}
