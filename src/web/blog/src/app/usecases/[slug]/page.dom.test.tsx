import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { useCases } from "@/lib/usecases";
import UseCasePage, { generateMetadata, generateStaticParams } from "./page";

vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
vi.mock("@blog/components/guides/story-demo", () => ({ StoryDemo: ({ label }: { label: string }) => <div data-testid="story-demo">{label}</div> }));

describe("use case pages", () => {
  it("prerenders every registered use case", () => {
    expect(generateStaticParams()).toEqual(useCases.map(({ slug }) => ({ slug })));
  });

  it.each(useCases)("renders $slug with its hero, body and demos", async (useCase) => {
    const params = Promise.resolve({ slug: useCase.slug });
    const { container } = render(await UseCasePage({ params }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(useCase.title);
    expect(screen.getByText(useCase.description)).toBeVisible();
    expect(container.querySelector("header img")?.getAttribute("src")).toContain(encodeURIComponent(useCase.image));
    expect(container.querySelector(".blog-prose h2")).not.toBeNull();
    expect(screen.getAllByTestId("story-demo").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "All use cases" })).toHaveAttribute("href", "/usecases");
    expect(await generateMetadata({ params })).toMatchObject({ alternates: { canonical: `https://alook.ai/usecases/${useCase.slug}` } });
  });
});
