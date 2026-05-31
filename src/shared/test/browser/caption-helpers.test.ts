import { describe, it, expect } from "vitest"
import {
  parseCaptionElements,
  deduplicateCaptions,
  formatTranscript,
  createTimestamp,
  groupIntoBlocks,
} from "../../src/browser/index"
import type { TranscriptEntry } from "../../src/browser/transcript"

describe("parseCaptionElements", () => {
  it("strips HTML tags from speaker and text", () => {
    const result = parseCaptionElements([
      { speakerHtml: "<span>Alice</span>", textHtml: "<b>Hello</b> world" },
    ])
    expect(result).toEqual([{ speaker: "Alice", text: "Hello world" }])
  })

  it("trims surrounding whitespace", () => {
    const result = parseCaptionElements([
      { speakerHtml: "  Bob  ", textHtml: "  hi there  " },
    ])
    expect(result).toEqual([{ speaker: "Bob", text: "hi there" }])
  })

  it("skips entries with empty speaker", () => {
    const result = parseCaptionElements([
      { speakerHtml: "", textHtml: "orphan text" },
      { speakerHtml: "<div></div>", textHtml: "also orphan" },
    ])
    expect(result).toEqual([])
  })

  it("skips entries with empty text", () => {
    const result = parseCaptionElements([{ speakerHtml: "Carol", textHtml: "<br/>" }])
    expect(result).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(parseCaptionElements([])).toEqual([])
  })

  it("preserves order and handles multiple entries", () => {
    const result = parseCaptionElements([
      { speakerHtml: "Alice", textHtml: "one" },
      { speakerHtml: "Bob", textHtml: "two" },
    ])
    expect(result).toEqual([
      { speaker: "Alice", text: "one" },
      { speaker: "Bob", text: "two" },
    ])
  })
})

describe("createTimestamp", () => {
  it("formats elapsed time as HH:MM:SS", () => {
    expect(createTimestamp(0, 0)).toBe("00:00:00")
    expect(createTimestamp(0, 5_000)).toBe("00:00:05")
    expect(createTimestamp(0, 65_000)).toBe("00:01:05")
    expect(createTimestamp(0, 3_661_000)).toBe("01:01:01")
  })

  it("clamps negative elapsed to zero", () => {
    expect(createTimestamp(10_000, 5_000)).toBe("00:00:00")
  })
})

describe("deduplicateCaptions", () => {
  const START = 0
  const NOW = 12_000 // -> 00:00:12

  it("appends a brand new caption", () => {
    const result = deduplicateCaptions([], [{ speaker: "Alice", text: "hi" }], START, NOW)
    expect(result).toEqual([{ speaker: "Alice", text: "hi", timestamp: "00:00:12" }])
  })

  it("drops an exact duplicate of the last entry", () => {
    const existing: TranscriptEntry[] = [{ speaker: "Alice", text: "hi", timestamp: "00:00:01" }]
    const result = deduplicateCaptions(existing, [{ speaker: "Alice", text: "hi" }], START, NOW)
    expect(result).toHaveLength(1)
    expect(result[0]!.timestamp).toBe("00:00:01")
  })

  it("extends the last entry when same speaker and incoming text is a superset", () => {
    const existing: TranscriptEntry[] = [{ speaker: "Alice", text: "hello", timestamp: "00:00:01" }]
    const result = deduplicateCaptions(existing, [{ speaker: "Alice", text: "hello world" }], START, NOW)
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe("hello world")
    // extension keeps the original timestamp
    expect(result[0]!.timestamp).toBe("00:00:01")
  })

  it("creates a new entry when the speaker changes", () => {
    const existing: TranscriptEntry[] = [{ speaker: "Alice", text: "hello", timestamp: "00:00:01" }]
    const result = deduplicateCaptions(existing, [{ speaker: "Bob", text: "hello" }], START, NOW)
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({ speaker: "Bob", text: "hello", timestamp: "00:00:12" })
  })

  it("only extends against pre-existing entries, not ones pushed in the same call", () => {
    // `last` is read from `existing` only; entries pushed during this call land in a
    // separate buffer, so the "superset extends last" rule does NOT apply transitively
    // within a single invocation. Documents the actual contract.
    const result = deduplicateCaptions(
      [],
      [
        { speaker: "Alice", text: "a" },
        { speaker: "Alice", text: "a b" },
        { speaker: "Bob", text: "c" },
      ],
      START,
      NOW,
    )
    expect(result.map((e) => `${e.speaker}:${e.text}`)).toEqual(["Alice:a", "Alice:a b", "Bob:c"])
  })

  it("extends across calls when the superset arrives in a later batch", () => {
    const first = deduplicateCaptions([], [{ speaker: "Alice", text: "hello" }], START, NOW)
    const second = deduplicateCaptions(first, [{ speaker: "Alice", text: "hello world" }], START, NOW)
    expect(second).toHaveLength(1)
    expect(second[0]!.text).toBe("hello world")
  })

  it("returns existing unchanged for empty incoming", () => {
    const existing: TranscriptEntry[] = [{ speaker: "Alice", text: "hi", timestamp: "00:00:01" }]
    expect(deduplicateCaptions(existing, [], START, NOW)).toEqual(existing)
  })
})

describe("groupIntoBlocks", () => {
  it("groups consecutive same-speaker entries into one block", () => {
    const blocks = groupIntoBlocks([
      { speaker: "Alice", text: "one", timestamp: "00:00:01" },
      { speaker: "Alice", text: "two", timestamp: "00:00:02" },
      { speaker: "Bob", text: "three", timestamp: "00:00:03" },
    ])
    expect(blocks).toEqual([
      { speaker: "Alice", lines: ["one", "two"], startTimestamp: "00:00:01" },
      { speaker: "Bob", lines: ["three"], startTimestamp: "00:00:03" },
    ])
  })

  it("returns empty for empty input", () => {
    expect(groupIntoBlocks([])).toEqual([])
  })
})

describe("formatTranscript", () => {
  it("returns empty string for no entries", () => {
    expect(formatTranscript([])).toBe("")
  })

  it("formats a single speaker block", () => {
    const out = formatTranscript([
      { speaker: "Alice", text: "hello", timestamp: "00:00:01" },
      { speaker: "Alice", text: "again", timestamp: "00:00:02" },
    ])
    expect(out).toBe("[00:00:01] Alice:\nhello\nagain")
  })

  it("separates speaker blocks with a blank line and keeps ordering", () => {
    const out = formatTranscript([
      { speaker: "Alice", text: "hi", timestamp: "00:00:01" },
      { speaker: "Bob", text: "yo", timestamp: "00:00:05" },
    ])
    expect(out).toBe("[00:00:01] Alice:\nhi\n\n[00:00:05] Bob:\nyo")
  })
})
