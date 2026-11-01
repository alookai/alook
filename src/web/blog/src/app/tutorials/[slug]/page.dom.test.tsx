import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/react-dom-harness";
import { stepGuides, tutorialAgents } from "@/lib/step-guides";
import StepGuidePage, { generateMetadata, generateStaticParams } from "./page";

vi.mock("@blog/components/guides/mock-scenes", () => ({
  ConnectDemo: ({ agents }: { agents: string[] }) => <div data-testid="connect-pair">{agents.join("+")}</div>,
  BotsDemo: ({ runtime, agents }: { runtime: string; agents: string[] }) => <div data-testid="bot-pair" data-runtime={runtime}>{agents.join("+")}</div>,
}));
vi.mock("@blog/components/guides/server-demo", () => ({ ServerDemo: ({ agents }: { agents: string[] }) => <div data-testid="server-pair">{agents.join("+")}</div> }));
vi.mock("@blog/components/guides/message-demo", () => ({ MessageDemo: () => <div /> }));

describe("paired tutorial pages", () => {
  it("prerenders all seven routes", () => {
    expect(generateStaticParams()).toEqual(stepGuides.map(({ slug }) => ({ slug })));
  });
  it.each(stepGuides)("renders $slug with its own content and animation pair", async (guide) => {
    const params = Promise.resolve({ slug: guide.slug });
    const { container } = render(await StepGuidePage({ params }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(guide.title);
    expect(screen.getByText(guide.description)).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(6);
    expect(screen.getByTestId("connect-pair")).toHaveTextContent(guide.agents.join("+"));
    expect(screen.getByTestId("server-pair")).toHaveTextContent(guide.agents.join("+"));
    expect(screen.getAllByTestId("bot-pair").map(node => node.dataset.runtime)).toEqual(guide.agents);
    for (const runtime of guide.agents) {
      const agent = tutorialAgents[runtime];
      expect(screen.getByRole("link", { name: agent.setupName, exact: true })).toHaveAttribute("href", agent.setupUrl);
      expect(container.querySelector(`#create-${runtime}`)).toHaveTextContent(`Create your ${agent.name} bot`);
    }
    for (const anchor of container.querySelectorAll('a[href^="#"]')) {
      expect(container.querySelector(anchor.getAttribute("href")!)).not.toBeNull();
    }
    expect(await generateMetadata({ params })).toMatchObject({ alternates: { canonical: `https://alook.ai/tutorials/${guide.slug}` } });
  });
});
