import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import TutorialsPage from "./page";
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
describe("Tutorials directory", () => {
  it("links to the independent tutorial without reusing Guides URLs", () => {
    render(<TutorialsPage />);
    expect(screen.getByRole("heading", { name: "Tutorials", level: 1 })).toBeVisible();
    expect(screen.getByRole("link", { name: /Use Codex and Claude Code/ })).toHaveAttribute("href", "/tutorials/codex-and-claude-code");
  });
});
