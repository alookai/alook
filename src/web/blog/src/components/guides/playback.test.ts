import { describe, expect, it } from "vitest";
import { closestVisibleGuide } from "./playback";

describe("tutorial viewport playback selection", () => {
  it("selects the centered scene when two scenes are visible", () => {
    expect(closestVisibleGuide([{ id: "bots", top: -120, height: 320 }, { id: "server", top: 215, height: 320 }], 938)).toBe("server");
  });
  it("changes owner on scroll even when neither scene crosses the 35% threshold", () => {
    expect(closestVisibleGuide([{ id: "bots", top: 200, height: 320 }, { id: "server", top: 650, height: 320 }], 938)).toBe("bots");
    expect(closestVisibleGuide([{ id: "bots", top: -70, height: 320 }, { id: "server", top: 380, height: 320 }], 938)).toBe("server");
  });
  it("selects no animation when no stage is substantially visible", () => {
    expect(closestVisibleGuide([{ id: "bots", top: -310, height: 320 }, { id: "server", top: 920, height: 320 }], 938)).toBeUndefined();
  });
});
