import { describe, it, expect } from "vitest"
import { parseCaptionElements, buildCaptionScrapeScript } from "./caption-scraper"

describe("caption-scraper", () => {
  describe("parseCaptionElements", () => {
    it("extracts speaker name and text from caption elements", () => {
      const result = parseCaptionElements([
        { speakerHtml: "Alice", textHtml: "Hello everyone" },
        { speakerHtml: "Bob", textHtml: "Hi Alice" },
      ])

      expect(result).toEqual([
        { speaker: "Alice", text: "Hello everyone" },
        { speaker: "Bob", text: "Hi Alice" },
      ])
    })

    it("handles multiple simultaneous speakers", () => {
      const result = parseCaptionElements([
        { speakerHtml: "Alice", textHtml: "Let me explain" },
        { speakerHtml: "Bob", textHtml: "Sure go ahead" },
        { speakerHtml: "Charlie", textHtml: "I agree" },
      ])

      expect(result).toHaveLength(3)
      expect(result[0].speaker).toBe("Alice")
      expect(result[1].speaker).toBe("Bob")
      expect(result[2].speaker).toBe("Charlie")
    })

    it("returns empty array when no captions visible", () => {
      const result = parseCaptionElements([])
      expect(result).toEqual([])
    })

    it("strips HTML tags from caption text", () => {
      const result = parseCaptionElements([
        { speakerHtml: "<span class='name'>Alice</span>", textHtml: "<b>Important</b> update" },
      ])

      expect(result).toEqual([
        { speaker: "Alice", text: "Important update" },
      ])
    })

    it("handles special characters in speaker names", () => {
      const result = parseCaptionElements([
        { speakerHtml: "José García", textHtml: "Hola" },
        { speakerHtml: "田中太郎", textHtml: "こんにちは" },
      ])

      expect(result).toEqual([
        { speaker: "José García", text: "Hola" },
        { speaker: "田中太郎", text: "こんにちは" },
      ])
    })

    it("skips entries with empty speaker or text", () => {
      const result = parseCaptionElements([
        { speakerHtml: "", textHtml: "orphan text" },
        { speakerHtml: "Alice", textHtml: "" },
        { speakerHtml: "Bob", textHtml: "valid" },
      ])

      expect(result).toEqual([
        { speaker: "Bob", text: "valid" },
      ])
    })

    it("trims whitespace from speaker and text", () => {
      const result = parseCaptionElements([
        { speakerHtml: "  Alice  ", textHtml: "  hello  " },
      ])

      expect(result).toEqual([
        { speaker: "Alice", text: "hello" },
      ])
    })

    it("handles nested HTML tags", () => {
      const result = parseCaptionElements([
        {
          speakerHtml: '<div class="outer"><span>Alice</span></div>',
          textHtml: '<div><span>Hello</span> <em>world</em></div>',
        },
      ])

      expect(result).toEqual([
        { speaker: "Alice", text: "Hello world" },
      ])
    })
  })

  describe("buildCaptionScrapeScript", () => {
    it("returns a non-empty JavaScript string", () => {
      const script = buildCaptionScrapeScript()
      expect(typeof script).toBe("string")
      expect(script.length).toBeGreaterThan(0)
    })

    it("is a self-invoking function", () => {
      const script = buildCaptionScrapeScript()
      expect(script).toMatch(/^\s*\(/)
      expect(script).toMatch(/\)\(\)\s*$/)
    })
  })
})
