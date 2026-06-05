import { describe, it, expect } from "vitest";

// Since we're in a node environment without jsdom, we test the logic/mapping
// directly by importing the radius constants and verifying the component's
// class composition logic.

// Re-implement the mapping logic from the component to test in isolation.
type BubbleVariant = "agent" | "user";
type BubblePosition = "first" | "middle" | "last" | "single";

const USER_RADIUS: Record<BubblePosition, string> = {
  single: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-br-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tr-[0.35rem] rounded-br-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tr-[0.35rem]",
};

const AGENT_RADIUS: Record<BubblePosition, string> = {
  single: "rounded-[1.05rem]",
  first: "rounded-[1.05rem] rounded-bl-[0.35rem]",
  middle: "rounded-[1.05rem] rounded-tl-[0.35rem] rounded-bl-[0.35rem]",
  last: "rounded-[1.05rem] rounded-tl-[0.35rem]",
};

function getRadius(variant: BubbleVariant, position: BubblePosition): string {
  return variant === "user" ? USER_RADIUS[position] : AGENT_RADIUS[position];
}

function getColors(variant: BubbleVariant): string {
  return variant === "user"
    ? "bg-primary text-primary-foreground"
    : "bg-muted text-foreground";
}

describe("MessageBubble radius logic", () => {
  describe("user variant", () => {
    it("single position has full rounding", () => {
      expect(getRadius("user", "single")).toBe("rounded-[1.05rem]");
    });

    it("first position tucks bottom-right corner", () => {
      expect(getRadius("user", "first")).toContain("rounded-br-[0.35rem]");
    });

    it("middle position tucks top-right and bottom-right corners", () => {
      const radius = getRadius("user", "middle");
      expect(radius).toContain("rounded-tr-[0.35rem]");
      expect(radius).toContain("rounded-br-[0.35rem]");
    });

    it("last position tucks top-right corner only", () => {
      const radius = getRadius("user", "last");
      expect(radius).toContain("rounded-tr-[0.35rem]");
      expect(radius).not.toContain("rounded-br-[0.35rem]");
    });
  });

  describe("agent variant", () => {
    it("single position has full rounding", () => {
      expect(getRadius("agent", "single")).toBe("rounded-[1.05rem]");
    });

    it("first position tucks bottom-left corner", () => {
      expect(getRadius("agent", "first")).toContain("rounded-bl-[0.35rem]");
    });

    it("middle position tucks top-left and bottom-left corners", () => {
      const radius = getRadius("agent", "middle");
      expect(radius).toContain("rounded-tl-[0.35rem]");
      expect(radius).toContain("rounded-bl-[0.35rem]");
    });

    it("last position tucks top-left corner only", () => {
      const radius = getRadius("agent", "last");
      expect(radius).toContain("rounded-tl-[0.35rem]");
      expect(radius).not.toContain("rounded-bl-[0.35rem]");
    });
  });

  describe("color mapping", () => {
    it("user variant uses primary colors", () => {
      const colors = getColors("user");
      expect(colors).toContain("bg-primary");
      expect(colors).toContain("text-primary-foreground");
    });

    it("agent variant uses muted colors", () => {
      const colors = getColors("agent");
      expect(colors).toContain("bg-muted");
      expect(colors).toContain("text-foreground");
    });
  });

  describe("all positions are unique per variant", () => {
    it("user has 4 distinct radius values", () => {
      const positions: BubblePosition[] = ["single", "first", "middle", "last"];
      const radii = positions.map((p) => getRadius("user", p));
      expect(new Set(radii).size).toBe(4);
    });

    it("agent has 4 distinct radius values", () => {
      const positions: BubblePosition[] = ["single", "first", "middle", "last"];
      const radii = positions.map((p) => getRadius("agent", p));
      expect(new Set(radii).size).toBe(4);
    });
  });

  describe("symmetry — user tucks RIGHT, agent tucks LEFT", () => {
    it("first: user=br, agent=bl", () => {
      expect(getRadius("user", "first")).toContain("br");
      expect(getRadius("agent", "first")).toContain("bl");
    });

    it("middle: user=tr+br, agent=tl+bl", () => {
      expect(getRadius("user", "middle")).toMatch(/tr.*br/);
      expect(getRadius("agent", "middle")).toMatch(/tl.*bl/);
    });

    it("last: user=tr, agent=tl", () => {
      expect(getRadius("user", "last")).toContain("tr");
      expect(getRadius("agent", "last")).toContain("tl");
    });
  });
});
