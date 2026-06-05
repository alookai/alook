import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("gsap", () => ({
  default: {
    registerPlugin: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock("@gsap/react", () => ({
  useGSAP: vi.fn(),
}));

vi.mock("gsap/ScrollTrigger", () => ({
  ScrollTrigger: {},
}));

describe("UseCasesSection", () => {
  it("renders the default active scene (Lead auto follow-up / DemoScene7)", async () => {
    const { UseCasesSection } = await import("./use-cases-section");
    const markup = renderToStaticMarkup(createElement(UseCasesSection));

    // Default active index is 0 = "lead-followup" scene
    expect(markup).toContain("sarah@acmecorp.com");
    expect(markup).toContain("What&#x27;s your pricing for a 50-person team?");
    expect(markup).toContain("Sales");
  });

  it("renders all 6 scenario picker buttons", async () => {
    const { UseCasesSection } = await import("./use-cases-section");
    const markup = renderToStaticMarkup(createElement(UseCasesSection));

    expect(markup).toContain("Lead auto follow-up");
    expect(markup).toContain("Monday 8am briefing");
    expect(markup).toContain("Daily store operations");
    // HTML entities for special chars
    expect(markup).toContain("Bug report");
    expect(markup).toContain("PR ready");
    expect(markup).toContain("Post an update");
    expect(markup).toContain("Fill this form");
  });

  it("renders section title and subtitle", async () => {
    const { UseCasesSection } = await import("./use-cases-section");
    const markup = renderToStaticMarkup(createElement(UseCasesSection));

    expect(markup).toContain("See It In Action");
    expect(markup).toContain("Use Cases");
    expect(markup).toContain("Real scenarios running on real agents");
  });

  it("renders window chrome with active scenario title", async () => {
    const { UseCasesSection } = await import("./use-cases-section");
    const markup = renderToStaticMarkup(createElement(UseCasesSection));

    expect(markup).toContain("alook — Lead auto follow-up");
  });

  it("uses AnimatedItem (old pattern) for non-migrated scenes", async () => {
    const { UseCasesSection } = await import("./use-cases-section");
    const markup = renderToStaticMarkup(createElement(UseCasesSection));

    // DemoScene7 (active by default) still uses AnimatedItem with class
    expect(markup).toContain("usecase-anim-item");
  });
});
