import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen, waitFor } from "@/test/react-dom-harness";
import { beginNavigation, clearActions, commitNavigation } from "@/lib/observability/context";
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry";
import { ObservedRouteCommit } from "@/lib/observability/regions";
import type { BlogPost } from "@blog/lib/blog/types";
import BlogPage from "./(index)/page";
import BlogPostPage, { generateMetadata, generateStaticParams } from "./[slug]/page";

const loaders = vi.hoisted(() => ({ all: vi.fn(), one: vi.fn() }));
vi.mock("@blog/lib/blog/posts", () => ({ getAllPosts: loaders.all, getPostBySlug: loaders.one }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
vi.mock("next/image", () => ({ default: ({ fill: _fill, preload: _preload, ...props }: ComponentProps<"img"> & { fill?: boolean; preload?: boolean }) => <img {...props} alt={props.alt ?? ""} /> }));
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
}));
vi.mock("@blog/content/introducing-alook.mdx", () => ({ default: () => <p>Shared rooms retain the team&apos;s context.</p>, jsonLd: { "@type": "FAQPage" } }));
vi.mock("@blog/content/local-ai-agents.mdx", () => ({ default: () => <p>Local agents work beside your tools.</p>, jsonLd: undefined }));

const posts: BlogPost[] = [
  { slug: "introducing-alook", title: "Human-AI Collaboration Moves to the Group Chat", date: "2026-08-01", author: "Alook", excerpt: "A shared room for people and agents.", readingTime: "5 min read" },
  { slug: "local-ai-agents", title: "Local AI agents", date: "2026-09-01", author: "Alook", excerpt: "Agents beside your tools.", readingTime: "4 min read" },
];
const events: Array<{ name: string; attributes: Record<string, string> }> = [];
const forAction = (id: string) => events.filter(event => event.attributes.action_id === id);
const ready = (id: string) => forAction(id).filter(event => event.name === "region.ready_commit");

beforeEach(() => {
  events.length = 0;
  loaders.all.mockReset().mockResolvedValue(posts);
  loaders.one.mockReset().mockImplementation(async (slug: string) => posts.find(post => post.slug === slug));
  window.history.replaceState(null, "", "/blog");
  configureTelemetry({ session_id: "blog-session" }, true);
  installTelemetrySink(event => events.push(event));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(async () => {
  await act(async () => { retireTelemetry(); clearActions(); });
  vi.unstubAllGlobals();
});

it("executes the actual index loader and renders ordered featured/recent links before reporting committed content", async () => {
  const navigation = beginNavigation("/blog")!;
  render(await BlogPage());
  expect(screen.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Featured article" })).toHaveTextContent("Local AI agents");
  expect(screen.getByRole("link", { name: /Human-AI Collaboration/ })).toHaveAttribute("href", "/blog/introducing-alook");
  await waitFor(() => expect(ready(navigation.id)).toHaveLength(1));
  expect(ready(navigation.id)[0]!.attributes).toMatchObject({ region: "page", route_template: "/blog" });
  expect(navigation.done).toBe(true);
});

it("renders the actual legal empty index after its loader completes", async () => {
  loaders.all.mockResolvedValueOnce([]);
  render(await BlogPage());
  expect(screen.getByText("New stories are on the way.")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Featured article" })).toBeNull();
  expect(screen.getByText("No recent stories in this topic yet.")).toBeVisible();
});

it("does not certify a retained old index after the URL commits while the actual article loader is still pending", async () => {
  const index = await BlogPage();
  const view = render(index);
  let release!: (post: BlogPost) => void;
  loaders.one.mockImplementationOnce(() => new Promise<BlogPost>(resolve => { release = resolve; }));
  let navigation!: NonNullable<ReturnType<typeof beginNavigation>>;
  let article!: ReturnType<typeof BlogPostPage>;
  await act(async () => {
    navigation = beginNavigation("/blog/introducing-alook")!;
    article = BlogPostPage({ params: Promise.resolve({ slug: "introducing-alook" }) });
  });
  await act(async () => {
    window.history.pushState(null, "", "/blog/introducing-alook");
    commitNavigation(window.location.pathname, "page");
  });
  expect(screen.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
  expect(ready(navigation.id)).toHaveLength(0);
  expect(navigation.done).toBe(false);
  await act(async () => { release(posts[0]!); view.rerender(await article); });
  expect(screen.getByRole("heading", { level: 1, name: posts[0]!.title })).toBeVisible();
  expect(screen.getByText("Shared rooms retain the team's context.")).toBeVisible();
  await waitFor(() => expect(ready(navigation.id)).toHaveLength(1));
  expect(forAction(navigation.id).filter(event => event.name === "action.finish").map(event => event.attributes.outcome)).toEqual(["success"]);
  expect(ready(navigation.id)[0]!.attributes.route_template).toBe("/blog/[slug]");
  expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(2);
});

it("finishes the new article navigation but rejects a late previous article tree", async () => {
  window.history.replaceState(null, "", "/blog/introducing-alook");
  const previous = await BlogPostPage({ params: Promise.resolve({ slug: "introducing-alook" }) });
  const view = render(previous);
  let navigation!: NonNullable<ReturnType<typeof beginNavigation>>;
  await act(async () => { navigation = beginNavigation("/blog/local-ai-agents")!; });
  await act(async () => {
    window.history.pushState(null, "", "/blog/local-ai-agents");
    commitNavigation(window.location.pathname, "page");
  });
  expect(ready(navigation.id)).toHaveLength(0);
  await act(async () => { view.rerender(await BlogPostPage({ params: Promise.resolve({ slug: "local-ai-agents" }) })); });
  expect(screen.getByRole("heading", { level: 1, name: "Local AI agents" })).toBeVisible();
  expect(screen.getByText("Local agents work beside your tools.")).toBeVisible();
  expect(ready(navigation.id)).toHaveLength(1);
  const count = events.filter(event => event.name === "region.ready_commit").length;
  await act(async () => { view.rerender(previous); });
  expect(events.filter(event => event.name === "region.ready_commit")).toHaveLength(count);
});

it("uses canonical post metadata/static params and invokes actual not-found for an unknown slug", async () => {
  expect(await generateStaticParams()).toEqual(posts.map(({ slug }) => ({ slug })));
  expect(await generateMetadata({ params: Promise.resolve({ slug: "introducing-alook" }) })).toMatchObject({ title: posts[0]!.title, alternates: { canonical: "https://alook.ai/blog/introducing-alook" } });
  expect(await generateMetadata({ params: Promise.resolve({ slug: "missing" }) })).toEqual({});
  await expect(BlogPostPage({ params: Promise.resolve({ slug: "missing" }) })).rejects.toThrow("404");
});

it("settles actual content mounted before the URL only after the independent router commit", async () => {
  const content = render(await BlogPage());
  const route = render(<ObservedRouteCommit />);
  let first!: NonNullable<ReturnType<typeof beginNavigation>>;
  await act(async () => { first = beginNavigation("/blog/introducing-alook")!; });
  await act(async () => { content.rerender(await BlogPostPage({ params: Promise.resolve({ slug: "introducing-alook" }) })); });
  expect(screen.getByRole("heading", { level: 1, name: posts[0]!.title })).toBeVisible();
  expect(ready(first.id)).toHaveLength(0);
  await act(async () => {
    window.history.pushState(null, "", "/blog/introducing-alook");
    route.rerender(<ObservedRouteCommit />);
  });
  expect(forAction(first.id).filter(event => event.name === "navigation.commit")).toHaveLength(1);
  expect(ready(first.id)).toHaveLength(1);
  expect(first.done).toBe(true);

  let second!: NonNullable<ReturnType<typeof beginNavigation>>;
  await act(async () => { second = beginNavigation("/blog/local-ai-agents")!; });
  await act(async () => { content.rerender(await BlogPostPage({ params: Promise.resolve({ slug: "local-ai-agents" }) })); });
  expect(ready(second.id)).toHaveLength(0);
  await act(async () => {
    window.history.pushState(null, "", "/blog/local-ai-agents");
    route.rerender(<ObservedRouteCommit />);
  });
  expect(ready(second.id)).toHaveLength(1);
  expect(forAction(second.id).filter(event => event.name === "action.finish").map(event => event.attributes.outcome)).toEqual(["success"]);
  await act(async () => { commitNavigation(window.location.pathname, "page"); });
  expect(ready(second.id)).toHaveLength(1);
});

it("renders a related article title before its summary and retains its destination", async () => {
  const related = { ...posts[1]!, slug: "ai-agent-vs-chatbot", title: "AI agent vs chatbot" };
  loaders.all.mockResolvedValueOnce([...posts, related]);
  render(await BlogPostPage({ params: Promise.resolve({ slug: "local-ai-agents" }) }));
  expect(screen.getByRole("heading", { name: "Keep exploring", level: 2 })).toBeVisible();
  const link = screen.getByRole("link", { name: /AI agent vs chatbot/ });
  expect(link).toHaveAttribute("href", "/blog/ai-agent-vs-chatbot");
  expect([...link.querySelectorAll("span")].map(child => child.textContent)).toEqual([
    related.title, "Decide whether I need an agent or a chatbot", related.readingTime,
  ]);
});
