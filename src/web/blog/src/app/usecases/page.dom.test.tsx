import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { useCases } from "@/lib/usecases";
import UseCasesPage from "./page";


describe("Use cases directory", () => {
  it("lists every use case under /usecases", () => {
    const { container } = render(<UseCasesPage />);
    expect(screen.getByRole("heading", { name: "Use cases", level: 1 })).toBeVisible();
    const links = [...container.querySelectorAll('[data-columns="1"] a')].map((link) => link.getAttribute("href"));
    expect(links).toEqual(useCases.map(({ slug }) => `/usecases/${slug}`));
  });
});
