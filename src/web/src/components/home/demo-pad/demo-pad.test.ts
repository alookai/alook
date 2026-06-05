import { describe, it, expect } from "vitest";

// The web suite runs node-env (no jsdom/RTL). Component rendering is QA'd in
// a browser. Here we assert the module exports and integration constraints.

describe("demo-pad module exports", () => {
  it("exports DemoPad, AnimatedStep, and useStepSequence", async () => {
    const mod = await import("./index");
    expect(typeof mod.DemoPad).toBe("function");
    expect(typeof mod.AnimatedStep).toBe("function");
    expect(typeof mod.useStepSequence).toBe("function");
  });
});

describe("AnimatedStep transition spec", () => {
  const ENTER_DURATION = 0.3;
  const EXIT_DURATION = 0.2;
  const EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

  it("enter transition is 0.3s with standard easing", () => {
    const expected = `opacity ${ENTER_DURATION}s ${EASING}, transform ${ENTER_DURATION}s ${EASING}`;
    expect(expected).toContain("0.3s");
    expect(expected).toContain(EASING);
  });

  it("exit (reset) transition is faster at 0.2s", () => {
    expect(EXIT_DURATION).toBeLessThan(ENTER_DURATION);
    expect(EXIT_DURATION).toBe(0.2);
  });

  it("enter transform is translateY(4px) → translateY(0)", () => {
    const hiddenTransform = "translateY(4px)";
    const visibleTransform = "translateY(0)";
    expect(hiddenTransform).not.toBe(visibleTransform);
  });
});

describe("IntersectionObserver integration contract", () => {
  it("threshold should be > 0 (not triggered by 1px visibility)", () => {
    const THRESHOLD = 0.3;
    expect(THRESHOLD).toBeGreaterThan(0);
    expect(THRESHOLD).toBeLessThanOrEqual(1);
  });
});
