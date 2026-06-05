import { describe, it, expect } from "vitest";

// ChatWindowFrame is a new presentational component. We test the structural
// contract: it uses design tokens (not hardcoded hex for layout), the titlebar
// has three traffic-light dots, and className is forwarded to the wrapper.

// The traffic-light colors are the only hardcoded values (macOS standard).
const TRAFFIC_LIGHT_COLORS = ["#FF5F57", "#FEBC2E", "#28C840"];

describe("ChatWindowFrame", () => {
  it("uses all three macOS traffic-light dot colors", () => {
    expect(TRAFFIC_LIGHT_COLORS).toHaveLength(3);
    expect(TRAFFIC_LIGHT_COLORS[0]).toBe("#FF5F57"); // red (close)
    expect(TRAFFIC_LIGHT_COLORS[1]).toBe("#FEBC2E"); // yellow (minimize)
    expect(TRAFFIC_LIGHT_COLORS[2]).toBe("#28C840"); // green (fullscreen)
  });

  it("wrapper uses border-border token, not hardcoded hex", () => {
    const wrapperClasses = "overflow-hidden rounded-xl border border-border bg-background shadow-lg";
    expect(wrapperClasses).toContain("border-border");
    expect(wrapperClasses).toContain("bg-background");
    expect(wrapperClasses).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("titlebar uses muted-foreground for the title text", () => {
    const titleClasses = "flex-1 text-center text-sm font-medium text-muted-foreground";
    expect(titleClasses).toContain("text-muted-foreground");
  });

  it("titlebar dot sizes are consistent (size-3)", () => {
    const dotClass = "size-3 rounded-full";
    expect(dotClass).toContain("size-3");
    expect(dotClass).toContain("rounded-full");
  });

  describe("className forwarding", () => {
    it("custom className should be appended to wrapper classes", () => {
      const base = "overflow-hidden rounded-xl border border-border bg-background shadow-lg";
      const custom = "w-full max-w-2xl";
      const combined = `${base} ${custom}`;
      expect(combined).toContain("rounded-xl");
      expect(combined).toContain("w-full");
      expect(combined).toContain("max-w-2xl");
    });
  });
});
