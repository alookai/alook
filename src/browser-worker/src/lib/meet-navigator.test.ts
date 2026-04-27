import { describe, it, expect } from "vitest"
import { isValidMeetUrl } from "./meet-navigator"

describe("meet-navigator", () => {
  describe("isValidMeetUrl", () => {
    it("accepts valid Google Meet URLs", () => {
      expect(isValidMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(true)
    })

    it("rejects Zoom URLs", () => {
      expect(isValidMeetUrl("https://zoom.us/j/1234567890")).toBe(false)
    })

    it("rejects URLs with wrong format", () => {
      expect(isValidMeetUrl("https://meet.google.com/abc")).toBe(false)
      expect(isValidMeetUrl("https://meet.google.com/abc-def-ghi-jkl")).toBe(false)
    })

    it("rejects non-meet Google URLs", () => {
      expect(isValidMeetUrl("https://calendar.google.com/abc-defg-hij")).toBe(false)
    })

    it("rejects empty string", () => {
      expect(isValidMeetUrl("")).toBe(false)
    })

    it("rejects URLs with uppercase letters in meeting code", () => {
      expect(isValidMeetUrl("https://meet.google.com/ABC-DEFG-HIJ")).toBe(false)
    })

    it("rejects URLs with extra path segments", () => {
      expect(isValidMeetUrl("https://meet.google.com/abc-defg-hij/extra")).toBe(false)
    })

    it("rejects URLs with query parameters", () => {
      expect(isValidMeetUrl("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(false)
    })
  })
})
