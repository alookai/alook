import { createElement, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, setupUser } from "@/test/react-dom-harness";
import { getAllPosts } from "@blog/lib/blog/posts";
import GuidesPage from "./page";
import BlogPage from "../blog/(index)/page";

vi.mock("@blog/lib/blog/posts", () => ({ getAllPosts: vi.fn() }));
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }));
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }));
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }));
vi.mock("next/image", () => ({ default: ({ fill: _fill, preload: _preload, ...props }: Record<string, unknown>) => createElement("img", props) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement("a", props, children) }));

const common = { date: "2026-10-12", author: "Alook", excerpt: "A practical example", readingTime: "3 min read" };
const posts = [
  { ...common, slug: "claude-code-and-codex-same-team", title: "Coding guide", tags: ["guides"] },
  { ...common, slug: "ai-agent-team", title: "Team guide", tags: ["guides"] },
  { ...common, slug: "why-we-built-alook", title: "Main article" },
];

beforeEach(() => {
  window.history.replaceState(null, "", "/guides");
  vi.mocked(getAllPosts).mockResolvedValue(posts);
});

describe("Guides directory", () => {
  it("shows every guide including the newest, supports category navigation, and omits empty categories", async () => {
    render(await GuidesPage());
    expect(screen.getByRole("heading", { level: 1, name: "Guides" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Coding guide/ })).toHaveAttribute("href", "/blog/claude-code-and-codex-same-team");
    expect(screen.getByRole("link", { name: /Team guide/ })).toBeVisible();
    expect(screen.queryByText("Main article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Solo business & no-code operations" })).not.toBeInTheDocument();
    await setupUser().click(screen.getByRole("button", { name: "Coding agents across runtimes & repos" }));
    expect(screen.getByRole("link", { name: /Coding guide/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Team guide/ })).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#coding-agents");
  });
  it("keeps guides out of the main Blog, including its featured article", async () => {
    render(await BlogPage());
    expect(screen.getByRole("link", { name: /Main article/ })).toBeVisible();
    expect(screen.queryByText("Coding guide")).not.toBeInTheDocument();
    expect(screen.queryByText("Team guide")).not.toBeInTheDocument();
  });
  it("renders the empty directory without inventing articles", async () => {
    vi.mocked(getAllPosts).mockResolvedValue([posts[2]]);
    render(await GuidesPage());
    expect(screen.getByRole("heading", { name: "Guides", level: 1 })).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
