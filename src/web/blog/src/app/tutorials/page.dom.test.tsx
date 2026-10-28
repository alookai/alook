import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { stepGuides } from "@/lib/step-guides";
import TutorialsPage from "./page";
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
describe("Tutorials directory", () => {
  it("links to the independent tutorial without reusing Guides URLs", () => {
    render(<TutorialsPage />);
    expect(screen.getByRole("heading", { name: "Tutorials", level: 1 })).toBeVisible();
    for (const guide of stepGuides) {
      expect(screen.getByRole("link", { name: new RegExp(guide.title) })).toHaveAttribute("href", `/tutorials/${guide.slug}`);
    }
  });
});
