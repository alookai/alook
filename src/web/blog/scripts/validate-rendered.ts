import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, options?: { contentType: string }) => { window: { document: Document } } };
import { blogTopics } from "../src/lib/blog/topics";
import { parseBlogDiscoveryManifest } from "../../src/lib/blog-discovery-manifest";
import { isDraftBlogPost, readBlogMetadata, type BlogMetadata } from "../src/lib/blog/validate-assets";

const origin = "https://alook.ai";
export type RenderedPost = { metadata: BlogMetadata; html: string };

export function validateRenderedPosts(
  posts: RenderedPost[],
  resourceExists: (pathname: string) => boolean,
  imageAssets: Record<string, { width: number; height: number }>,
  redirects: Record<string, string> = {},
): string[] {
  const errors: string[] = [];
  const documents = new Map(posts.map(({ metadata, html }) => [`/blog/${metadata.slug}`, new JSDOM(html).window.document]));
  const titles = new Set<string>();
  for (const { metadata: post } of posts) {
    const pathname = `/blog/${post.slug}`;
    const doc = documents.get(pathname)!;
    const fail = (message: string) => errors.push(`${pathname}: ${message}`);
    const meta = (name: string) => doc.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.getAttribute("content");
    const title = doc.querySelector("title")?.textContent?.trim();
    if (!title || titles.has(title)) fail("missing or duplicate title");
    if (title) titles.add(title);
    if (!meta("description")?.trim()) fail("missing description");
    const h1 = doc.querySelectorAll("h1");
    if (h1.length !== 1 || h1[0].textContent?.trim() !== post.title) fail("expected one H1 matching the article title");
    if (!doc.querySelector(".blog-content")?.textContent?.trim()) fail("missing article body");
    const canonical = doc.querySelectorAll('link[rel="canonical"]');
    if (canonical.length !== 1 || canonical[0].getAttribute("href") !== origin + pathname) fail("invalid canonical");
    if ([...doc.querySelectorAll('meta[name="robots"],meta[name="googlebot"]')].some((node) => /\b(noindex|none)\b/i.test(node.getAttribute("content") ?? ""))) fail("article is noindex");
    const ids = [...doc.querySelectorAll("[id]")].map((node) => node.id);
    if (new Set(ids).size !== ids.length) fail("duplicate anchor id");
    const entities: Record<string, unknown>[] = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent ?? "");
        entities.push(...(Array.isArray(data) ? data : [data]));
      } catch { fail("invalid JSON-LD"); }
    }
    const articles = entities.filter((entity) => entity?.["@type"] === "BlogPosting");
    if (articles.length !== 1 || articles[0].url !== origin + pathname || articles[0].headline !== post.title || articles[0].datePublished !== post.date || articles[0].dateModified !== post.dateModified || (articles[0].author as { name?: string } | undefined)?.name !== post.author) fail("BlogPosting conflicts with article metadata");
    const og = meta("og:image");
    if (!og) fail("missing OG image");
    if (og) {
      const url = new URL(og, origin);
      if (url.origin !== origin || url.pathname !== (post.image ?? `/og/blog/${encodeURIComponent(post.slug)}`)) fail("OG image conflicts with article metadata");
      const asset = imageAssets[url.pathname];
      if (url.origin === origin && !url.pathname.startsWith("/og/blog/") && !resourceExists(url.pathname)) fail(`missing OG resource ${url.pathname}`);
      if (asset && (Number(meta("og:image:width")) !== asset.width || Number(meta("og:image:height")) !== asset.height)) fail("OG dimensions conflict with resource");
    }
    for (const img of doc.querySelectorAll<HTMLImageElement>(".blog-content img")) {
      const src = img.getAttribute("src") ?? "";
      const asset = imageAssets[src];
      if (!resourceExists(src)) fail(`missing image ${src}`);
      if (!img.hasAttribute("alt")) fail(`missing alt ${src}`);
      if (!asset || Number(img.getAttribute("width")) !== asset.width || Number(img.getAttribute("height")) !== asset.height) fail(`invalid image dimensions ${src}`);
      for (const candidate of (img.getAttribute("srcset") ?? "").split(",").filter(Boolean)) {
        if (!resourceExists(candidate.trim().split(/\s+/)[0])) fail(`missing responsive image ${candidate}`);
      }
    }
    for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const url = new URL(link.getAttribute("href")!, origin + pathname);
      if (url.origin !== origin) continue;
      const normalizedPath = url.pathname.replace(/\/+$/, "");
      const target = (redirects[normalizedPath] ?? normalizedPath).replace(/\/+$/, "");
      if (!target.startsWith("/blog/")) continue;
      const targetDoc = documents.get(target);
      if (!targetDoc) { if (!resourceExists(target)) fail(`missing article/link ${target}`); continue; }
      if (url.hash && !targetDoc.getElementById(decodeURIComponent(url.hash.slice(1)))) fail(`missing fragment ${target}${url.hash}`);
    }
  }
  return errors;
}

export function validateBlogBuild(blogRoot: string): void {
  const content = resolve(blogRoot, "src/content");
  const output = resolve(blogRoot, ".next/server/app/blog");
  const posts: RenderedPost[] = [];
  for (const file of readdirSync(content).filter((file) => file.endsWith(".mdx"))) {
    const source = readFileSync(resolve(content, file), "utf8");
    const { metadata } = readBlogMetadata(source, file.slice(0, -4));
    const builtFile = resolve(output, `${metadata.slug}.html`);
    if (isDraftBlogPost(source)) {
      if (existsSync(builtFile)) throw new Error(`Draft was prerendered: ${metadata.slug}`);
      continue;
    }
    posts.push({ metadata, html: readFileSync(builtFile, "utf8") });
  }
  const expected = posts.map(({ metadata }) => metadata.slug).sort();
  const samePosts = (label: string, slugs: string[]) => {
    if (JSON.stringify([...slugs].sort()) !== JSON.stringify(expected)) throw new Error(`${label} differs from published articles`);
  };
  samePosts("Topics", blogTopics.flatMap((topic) => topic.entries.map((entry) => entry.slug)));
  const serverRoot = resolve(blogRoot, ".next/server/app");
  const discovery = parseBlogDiscoveryManifest(JSON.parse(readFileSync(resolve(serverRoot, "internal/blog-discovery.body"), "utf8")));
  samePosts("Discovery manifest", discovery.posts.map((post) => post.slug));
  const feed = new JSDOM(readFileSync(resolve(serverRoot, "blog/feed.xml.body"), "utf8"), { contentType: "application/xml" });
  samePosts("RSS", [...feed.window.document.querySelectorAll("item > link")].map((link) => link.textContent?.split("/blog/")[1] ?? ""));
  const index = new JSDOM(readFileSync(resolve(serverRoot, "blog.html"), "utf8"));
  samePosts("Blog index", [...new Set([...index.window.document.querySelectorAll<HTMLAnchorElement>('a[href^="/blog/"]')].map((link) => link.getAttribute("href")!.slice(6)).filter((slug) => !slug.includes("/") && slug !== "feed.xml"))]);
  const imageAssets = JSON.parse(readFileSync(resolve(blogRoot, "src/lib/blog/image-assets.json"), "utf8"));
  const redirects = JSON.parse(readFileSync(resolve(blogRoot, "src/lib/blog/redirects.json"), "utf8")) as { source: string; destination: string }[];
  const errors = validateRenderedPosts(posts, (pathname) => { const file = resolve(blogRoot, "public", `.${pathname}`); return existsSync(file) && statSync(file).isFile(); }, imageAssets, Object.fromEntries(redirects.map(({ source, destination }) => [source, destination])));
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Validated rendered HTML for ${posts.length} Blog articles.`);
}

/* istanbul ignore if */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validateBlogBuild(resolve(import.meta.dirname, ".."));
