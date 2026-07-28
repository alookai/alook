import { describe, it, expect } from "vitest";
import {
  BOT_ACTIVITY_PRESETS,
  RUNNING_PRESETS,
  BOT_ACTIVITY_STATUS_PAIRS,
  isBotActivityStatus,
  pickBotActivityPreset,
} from "../../src/community/bot-activity-presets";

describe("isBotActivityStatus — the shared write-path / reconciler guard", () => {
  it("classifies EVERY emitted preset as a bot-activity status (no drift between the guard and what the pipeline writes)", () => {
    // Guards Blair's over-reach concern: if a preset the pipeline emits isn't
    // recognized here, the write path would freeze that pill as if it were a
    // custom status. Every idle/starting/stopping preset and every running
    // variant must be classified writable.
    for (const state of ["idle", "starting", "stopping", "running"] as const) {
      // Sample the whole running pool via deterministic seeds, not just one.
      const seeds = state === "running" ? RUNNING_PRESETS.map((_, i) => i / RUNNING_PRESETS.length) : [0];
      for (const seed of seeds) {
        const p = pickBotActivityPreset(state, seed);
        expect(isBotActivityStatus(p.emoji, p.text)).toBe(true);
      }
    }
    // And the canonical pair list agrees.
    for (const p of BOT_ACTIVITY_STATUS_PAIRS) {
      expect(isBotActivityStatus(p.emoji, p.text)).toBe(true);
    }
  });

  it("treats a null pair (no status set) as writable — not a custom status", () => {
    expect(isBotActivityStatus(null, null)).toBe(false);
  });

  it("treats an owner-set custom status as NOT a bot-activity status (so the pipeline leaves it alone)", () => {
    expect(isBotActivityStatus("🎨", "Painting")).toBe(false);
    // A preset emoji with different text is still custom — both must match.
    expect(isBotActivityStatus(BOT_ACTIVITY_PRESETS.idle.emoji, "On vacation")).toBe(false);
    // A preset text with a different emoji is likewise custom.
    expect(isBotActivityStatus("🏖️", BOT_ACTIVITY_PRESETS.idle.text)).toBe(false);
  });

  it("the pair list covers exactly the presets, so guard membership can't silently diverge", () => {
    const expected = [
      BOT_ACTIVITY_PRESETS.idle,
      BOT_ACTIVITY_PRESETS.starting,
      BOT_ACTIVITY_PRESETS.stopping,
      ...RUNNING_PRESETS,
    ];
    expect(BOT_ACTIVITY_STATUS_PAIRS).toEqual(expected);
  });
});
