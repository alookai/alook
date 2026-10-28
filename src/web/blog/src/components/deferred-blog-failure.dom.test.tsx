import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { BlogFailureBoundary } from "./deferred-blog-failure";
vi.mock("@/components/public-layout", () => ({ ZoneLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
function Broken(): React.ReactNode { throw new Error("Chunk unavailable"); }
describe("Blog failure fallback", () => {
  it.each([[true, "Page not found"], [false, "Something went wrong"]] as const)("keeps readable recovery when a visual chunk fails (%s)", (missing, title) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<BlogFailureBoundary missing={missing}><Broken /></BlogFailureBoundary>);
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
    } finally { log.mockRestore(); }
  });
});
