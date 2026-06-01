import { describe, it, expect } from "vitest";
import {
  CHAT_PLACEHOLDER_HINTS,
  HINT_HOLD_MS,
  randomStartIndex,
  nextIndex,
  shouldRotate,
} from "./use-rotating-placeholder";

// The web suite runs node-env (no jsdom/RTL — see agent-chat-view.test.ts), so
// the hook itself can't be rendered here. All testable logic was extracted into
// the pure helpers below, which is where every behavioral assertion lives.
// Component-render / layout / aria checks are QA'd in a real browser.

describe("CHAT_PLACEHOLDER_HINTS", () => {
  it("contains the 5 LOCKED copy strings in order", () => {
    expect([...CHAT_PLACEHOLDER_HINTS]).toEqual([
      "Email the team this week's launch update",
      "Recruit a QA agent to review my PRs",
      "Remind me to follow up with Acme on Thursday",
      "What did we ship last week?",
      "Fix the failing test in the checkout flow",
    ]);
  });

  it("keeps every hint ≤ 45 chars (guards mobile truncation)", () => {
    for (const hint of CHAT_PLACEHOLDER_HINTS) {
      expect(hint.length, hint).toBeLessThanOrEqual(45);
    }
  });

  it("holds each hint ~6s", () => {
    expect(HINT_HOLD_MS).toBe(6000);
  });
});

describe("randomStartIndex", () => {
  it("returns an index within [0, len)", () => {
    const len = CHAT_PLACEHOLDER_HINTS.length;
    // sweep rand across [0,1) and assert every result is a valid index
    for (let r = 0; r < 1; r += 0.01) {
      const i = randomStartIndex(len, () => r);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(len);
    }
  });

  it("maps rand=0 to the first and rand→1 to the last", () => {
    const len = 5;
    expect(randomStartIndex(len, () => 0)).toBe(0);
    expect(randomStartIndex(len, () => 0.999999)).toBe(len - 1);
  });

  it("returns 0 for an empty list (defensive)", () => {
    expect(randomStartIndex(0, () => 0.5)).toBe(0);
  });
});

describe("nextIndex", () => {
  it("advances sequentially", () => {
    expect(nextIndex(0, 5)).toBe(1);
    expect(nextIndex(1, 5)).toBe(2);
    expect(nextIndex(3, 5)).toBe(4);
  });

  it("wraps to 0 after the last", () => {
    expect(nextIndex(4, 5)).toBe(0);
  });

  it("cycles the full sequence back to start", () => {
    const len = CHAT_PLACEHOLDER_HINTS.length;
    let i = 2;
    const seen: number[] = [i];
    for (let n = 0; n < len; n++) {
      i = nextIndex(i, len);
      seen.push(i);
    }
    // after len steps we're back where we started
    expect(seen[seen.length - 1]).toBe(2);
    // and we visited every index exactly once along the way
    expect(new Set(seen.slice(0, len)).size).toBe(len);
  });

  it("returns 0 for an empty list (defensive)", () => {
    expect(nextIndex(0, 0)).toBe(0);
  });
});

describe("shouldRotate", () => {
  const base = {
    isEmpty: true,
    isFocused: false,
    isTaskActive: false,
    reducedMotion: false,
  };

  it("rotates only when empty, unfocused, idle, and motion allowed", () => {
    expect(shouldRotate(base)).toBe(true);
  });

  it("freezes when focused", () => {
    expect(shouldRotate({ ...base, isFocused: true })).toBe(false);
  });

  it("freezes when the field is non-empty (typing)", () => {
    expect(shouldRotate({ ...base, isEmpty: false })).toBe(false);
  });

  it("freezes when a task is active", () => {
    expect(shouldRotate({ ...base, isTaskActive: true })).toBe(false);
  });

  it("does not rotate under reduced motion", () => {
    expect(shouldRotate({ ...base, reducedMotion: true })).toBe(false);
  });

  it("blur with an empty field re-enables rotation", () => {
    // focused → frozen, then blur (isFocused:false) with empty field → rotates
    expect(shouldRotate({ ...base, isFocused: true })).toBe(false);
    expect(shouldRotate({ ...base, isFocused: false })).toBe(true);
  });
});
