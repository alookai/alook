import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeTime, timeAgo } from "./time.js";

describe("relativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for invalid date", () => {
    expect(relativeTime("not-a-date")).toBe("");
    expect(relativeTime("")).toBe("");
  });

  it("returns 'just now' for less than 1 minute ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:30Z"));
    expect(relativeTime("2026-05-29T12:00:00Z")).toBe("just now");
    vi.useRealTimers();
  });

  it("returns minutes ago for 1-59 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:05:00Z"));
    expect(relativeTime("2026-05-29T12:00:00Z")).toBe("5m ago");
    vi.useRealTimers();
  });

  it("returns hours ago for 1-23 hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T15:00:00Z"));
    expect(relativeTime("2026-05-29T12:00:00Z")).toBe("3h ago");
    vi.useRealTimers();
  });

  it("returns days ago for 1-6 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
    expect(relativeTime("2026-05-29T12:00:00Z")).toBe("2d ago");
    vi.useRealTimers();
  });

  it("returns formatted date for 7+ days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const result = relativeTime("2026-05-20T12:00:00Z");
    expect(result).not.toContain("ago");
    expect(result).not.toBe("just now");
    expect(result).not.toBe("");
    expect(result.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

describe("timeAgo", () => {
  it("returns 'never' when given null", () => {
    expect(timeAgo(null)).toBe("never");
  });
  it("delegates to relativeTime for a real timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:05:00Z"));
    expect(timeAgo("2026-05-29T12:00:00Z")).toBe("5m ago");
    vi.useRealTimers();
  });
});
