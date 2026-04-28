import { describe, it, expect } from "vitest"
import {
  createTimestamp,
  deduplicateCaptions,
  groupIntoBlocks,
  formatTranscript,
} from "@alook/shared/browser"
import type { TranscriptEntry } from "@alook/shared/browser"

describe("transcript", () => {
  describe("createTimestamp", () => {
    it("formats 0 elapsed as 00:00:00", () => {
      expect(createTimestamp(1000, 1000)).toBe("00:00:00")
    })

    it("formats seconds correctly", () => {
      expect(createTimestamp(0, 45_000)).toBe("00:00:45")
    })

    it("formats minutes and seconds", () => {
      expect(createTimestamp(0, 125_000)).toBe("00:02:05")
    })

    it("formats hours, minutes, and seconds", () => {
      expect(createTimestamp(0, 3_661_000)).toBe("01:01:01")
    })

    it("handles negative elapsed time as 00:00:00", () => {
      expect(createTimestamp(5000, 1000)).toBe("00:00:00")
    })
  })

  describe("deduplicateCaptions", () => {
    const START = 0

    it("deduplicates overlapping caption fragments from same speaker", () => {
      const existing: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hello", timestamp: "00:00:05" },
      ]
      const incoming = [{ speaker: "Alice", text: "Hello" }]

      const result = deduplicateCaptions(existing, incoming, START, 8000)
      expect(result).toHaveLength(1)
      expect(result[0].text).toBe("Hello")
    })

    it("merges partial captions (Google Meet updates captions in-place)", () => {
      const existing: TranscriptEntry[] = [
        { speaker: "Alice", text: "I think we should", timestamp: "00:00:05" },
      ]
      const incoming = [{ speaker: "Alice", text: "I think we should focus on testing" }]

      const result = deduplicateCaptions(existing, incoming, START, 8000)
      expect(result).toHaveLength(1)
      expect(result[0].text).toBe("I think we should focus on testing")
    })

    it("adds new entry when speaker changes", () => {
      const existing: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hello", timestamp: "00:00:05" },
      ]
      const incoming = [{ speaker: "Bob", text: "Hi there" }]

      const result = deduplicateCaptions(existing, incoming, START, 10_000)
      expect(result).toHaveLength(2)
      expect(result[1].speaker).toBe("Bob")
      expect(result[1].text).toBe("Hi there")
    })

    it("handles empty incoming list", () => {
      const existing: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hello", timestamp: "00:00:05" },
      ]

      const result = deduplicateCaptions(existing, [], START, 10_000)
      expect(result).toHaveLength(1)
    })

    it("handles empty existing list", () => {
      const incoming = [
        { speaker: "Alice", text: "Hello" },
        { speaker: "Bob", text: "Hi" },
      ]

      const result = deduplicateCaptions([], incoming, START, 5000)
      expect(result).toHaveLength(2)
      expect(result[0].timestamp).toBe("00:00:05")
    })

    it("preserves speaker order when speakers alternate", () => {
      const existing: TranscriptEntry[] = []
      const incoming = [
        { speaker: "Alice", text: "Question?" },
        { speaker: "Bob", text: "Answer." },
        { speaker: "Alice", text: "Thanks!" },
      ]

      const result = deduplicateCaptions(existing, incoming, START, 30_000)
      expect(result).toHaveLength(3)
      expect(result.map((e) => e.speaker)).toEqual(["Alice", "Bob", "Alice"])
    })
  })

  describe("groupIntoBlocks", () => {
    it("groups consecutive captions from same speaker into one block", () => {
      const entries: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hello", timestamp: "00:00:05" },
        { speaker: "Alice", text: "How are you?", timestamp: "00:00:08" },
        { speaker: "Bob", text: "Good thanks", timestamp: "00:00:12" },
      ]

      const blocks = groupIntoBlocks(entries)
      expect(blocks).toHaveLength(2)
      expect(blocks[0].speaker).toBe("Alice")
      expect(blocks[0].lines).toEqual(["Hello", "How are you?"])
      expect(blocks[0].startTimestamp).toBe("00:00:05")
      expect(blocks[1].speaker).toBe("Bob")
      expect(blocks[1].lines).toEqual(["Good thanks"])
    })

    it("handles empty entries", () => {
      expect(groupIntoBlocks([])).toEqual([])
    })

    it("creates separate blocks when same speaker re-appears", () => {
      const entries: TranscriptEntry[] = [
        { speaker: "Alice", text: "First", timestamp: "00:00:05" },
        { speaker: "Bob", text: "Middle", timestamp: "00:00:10" },
        { speaker: "Alice", text: "Again", timestamp: "00:00:15" },
      ]

      const blocks = groupIntoBlocks(entries)
      expect(blocks).toHaveLength(3)
      expect(blocks[2].speaker).toBe("Alice")
      expect(blocks[2].lines).toEqual(["Again"])
    })
  })

  describe("formatTranscript", () => {
    it("produces clean text output with speaker names and timestamps", () => {
      const entries: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hello everyone", timestamp: "00:00:05" },
        { speaker: "Alice", text: "Let's start", timestamp: "00:00:08" },
        { speaker: "Bob", text: "Sounds good", timestamp: "00:00:12" },
      ]

      const output = formatTranscript(entries)
      expect(output).toBe(
        "[00:00:05] Alice:\nHello everyone\nLet's start\n\n[00:00:12] Bob:\nSounds good"
      )
    })

    it("handles empty caption list", () => {
      expect(formatTranscript([])).toBe("")
    })

    it("handles single entry", () => {
      const entries: TranscriptEntry[] = [
        { speaker: "Alice", text: "Solo speaker", timestamp: "00:01:30" },
      ]

      const output = formatTranscript(entries)
      expect(output).toBe("[00:01:30] Alice:\nSolo speaker")
    })

    it("preserves alternating speaker order", () => {
      const entries: TranscriptEntry[] = [
        { speaker: "Alice", text: "Hi", timestamp: "00:00:01" },
        { speaker: "Bob", text: "Hey", timestamp: "00:00:03" },
        { speaker: "Alice", text: "Bye", timestamp: "00:00:05" },
      ]

      const output = formatTranscript(entries)
      const blocks = output.split("\n\n")
      expect(blocks).toHaveLength(3)
      expect(blocks[0]).toContain("Alice")
      expect(blocks[1]).toContain("Bob")
      expect(blocks[2]).toContain("Alice")
    })
  })
})
