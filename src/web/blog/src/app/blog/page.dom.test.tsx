import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@/test/react-dom-harness";
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

beforeEach(() => {
  loaders.all.mockReset().mockResolvedValue(posts);
  loaders.one.mockReset().mockImplementation(async (slug: string) => posts.find(post => post.slug === slug));
  window.history.replaceState(null, "", "/blog");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => { vi.unstubAllGlobals(); });

it("executes the actual index loader and renders ordered featured and recent links", async () => {
  render(await BlogPage());
  expect(screen.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Featured article" })).toHaveTextContent("Local AI agents");
  for (const link of screen.getAllByRole("link", { name: /Human-AI Collaboration/ })) expect(link).toHaveAttribute("href", "/blog/introducing-alook");
});

it("renders the actual legal empty index after its loader completes", async () => {
  loaders.all.mockResolvedValueOnce([]);
  render(await BlogPage());
  expect(screen.getByText("New stories are on the way.")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Featured article" })).toBeNull();
  expect(screen.getByText("No recent stories in this topic yet.")).toBeVisible();
});

it("renders article content with structured data", async () => {
  render(await BlogPostPage({ params: Promise.resolve({ slug: "introducing-alook" }) }));
  expect(screen.getByRole("heading", { level: 1, name: posts[0]!.title })).toBeVisible();
  expect(screen.getByText("Shared rooms retain the team's context.")).toBeVisible();
  expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(2);
});

it("uses canonical post metadata/static params and invokes actual not-found for an unknown slug", async () => {
  expect(await generateStaticParams()).toEqual(posts.map(({ slug }) => ({ slug })));
  expect(await generateMetadata({ params: Promise.resolve({ slug: "introducing-alook" }) })).toMatchObject({ title: posts[0]!.title, alternates: { canonical: "https://alook.ai/blog/introducing-alook" } });
  expect(await generateMetadata({ params: Promise.resolve({ slug: "missing" }) })).toEqual({});
  await expect(BlogPostPage({ params: Promise.resolve({ slug: "missing" }) })).rejects.toThrow("404");
});

it("ends an article with the upgraded Alook product CTA and next pillar", async () => {
  render(await BlogPostPage({ params: Promise.resolve({ slug: "local-ai-agents" }) }));
  expect(screen.queryByRole("heading", { name: "Keep exploring" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Start Free" })).toHaveAttribute("href", "/sign-in?cta_placement=blog-end");
  expect(screen.getByRole("link", { name: "See use cases" })).toHaveAttribute("href", "/usecases");
  expect(screen.getByRole("link", { name: "More blogs" })).toHaveAttribute("href", "/blog");
});
