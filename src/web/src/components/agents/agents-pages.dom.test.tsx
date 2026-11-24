import type { ComponentProps } from "react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { AGENT_RUNTIME_PAGES, getAgentRuntimePage } from "@/lib/agents"
import { AgentDetailView } from "./agent-detail-view"
import { AgentsHubView } from "./agents-hub-view"

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : String(href)} {...props}>{children}</a>
  ),
}))
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}))
vi.mock("@/lib/analytics", () => ({
  trackLandingCtaClicked: vi.fn(),
  trackGithubOutboundClicked: vi.fn(),
}))

describe("Agents marketing pages", () => {
  it("renders all verified local runtimes on /agents with JSON-LD", () => {
    const { container } = render(<AgentsHubView />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Bring your local agents into one room/i)
    for (const agent of AGENT_RUNTIME_PAGES) {
      expect(container.querySelector(`a[href="/agents/${agent.slug}"]`)).not.toBeNull()
    }
    const schema = container.querySelector('script[type="application/ld+json"]')?.textContent ?? ""
    expect(schema).toContain('"CollectionPage"')
    expect(schema).toContain('"FAQPage"')
    expect(schema).toContain('"BreadcrumbList"')
  })

  it("renders runtime capabilities, setup steps, related tutorials/comparisons, and FAQ on /agents/[slug]", () => {
    const agent = getAgentRuntimePage("claude-code")!
    const { container } = render(<AgentDetailView agent={agent} />)

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Your Claude Code, always in the room/i)
    expect(screen.getByText("Verified runtime capabilities")).toBeVisible()
    expect(container.querySelector('a[href="/tutorials/codex-and-claude-code"]')).not.toBeNull()
    expect(container.querySelector('a[href="/compare/alook-vs-myclaw"]')).not.toBeNull()

    const schema = container.querySelector('script[type="application/ld+json"]')?.textContent ?? ""
    expect(schema).toContain('"HowTo"')
    expect(schema).toContain('"FAQPage"')
    expect(schema).toContain('"BreadcrumbList"')
  })
})
