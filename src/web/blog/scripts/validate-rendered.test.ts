import { describe, expect, it, vi } from "vitest";
import { validateBlogBuild, validateRenderedPosts } from "./validate-rendered";
import { readBlogMetadata } from "../src/lib/blog/validate-assets";

const metadata = { slug: "example", title: "Example", date: "2026-10-09", author: "Alook Team", excerpt: "Example article", readingTime: "5 min read", image: "/blog/example/hero.webp" };
const assets = { "/blog/example/hero.webp": { width: 1200, height: 800 } };
const html = `<title>Example — Alook</title><meta name="description" content="Example article">
<link rel="canonical" href="https://alook.ai/blog/example">
<meta property="og:image" content="https://alook.ai/blog/example/hero.webp">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">
<h1>Example</h1><div class="blog-content"><h2 id="section">Section</h2><p>Actual body</p>
<img src="/blog/example/hero.webp" alt="" width="1200" height="800"><a href="#section">Section</a></div>
<script type="application/ld+json">${JSON.stringify({ "@type": "BlogPosting", url: "https://alook.ai/blog/example", headline: "Example", datePublished: metadata.date, author: { name: metadata.author } })}</script>`;
const validate = (body = html) => validateRenderedPosts([{ metadata, html: body }], (src) => src in assets, assets);

describe("rendered article contract", () => {
  it("accepts a real body, matching metadata, an anchor and explicitly decorative alt", () => expect(validate()).toEqual([]));
  it.each([
    ["<h1>Example</h1>", "", "one H1"],
    ["<h1>Example</h1>", "<h1>Example</h1><h1>Duplicate</h1>", "one H1"],
    ["Example — Alook", "  ", "title"],
    ['content="Example article"', 'content=" "', "description"],
    ['href="https://alook.ai/blog/example"', 'href="https://alook.ai/blog/wrong"', "canonical"],
    ["<title>", '<meta name="robots" content="noindex"><title>', "noindex"],
    ['href="#section"', 'href="/blog/missing"', "missing article"],
    ['href="#section"', 'href="#missing"', "missing fragment"],
    ['width="1200"', 'width="1"', "image dimensions"],
    ['alt=""', "", "missing alt"],
    ['src="/blog/example/hero.webp"', 'src="/blog/example/missing.webp"', "missing image"],
    ['property="og:image:height" content="800"', 'property="og:image:height" content="630"', "OG dimensions"],
    ['"headline":"Example"', '"headline":"Wrong"', "BlogPosting"],
    ['{"@type":"BlogPosting"', '{broken:"BlogPosting"', "invalid JSON-LD"],
  ])("rejects mutation %s", (from, to, expected) => {
    expect(validate(html.replace(from, to)).join("\n")).toContain(expected);
  });
  it("accepts canonical redirects and index links while rejecting bad fragments and articles", () => {
    for (const href of ["/blog", "/blog/", "/blog/example/", "/blog/example/#section"]) {
      expect(validate(html.replace('href="#section"', `href="${href}"`))).toEqual([]);
    }
    expect(validateRenderedPosts([{ metadata, html: html.replace('href="#section"', 'href="/blog/old/#section"') }], (src) => src in assets, assets, { "/blog/old": "/blog/example" })).toEqual([]);
    expect(validate(html.replace('href="#section"', 'href="/blog/example/#missing"')).join()).toContain("missing fragment");
    expect(validate(html.replace('href="#section"', 'href="/blog/missing/"')).join()).toContain("missing article");
  });
  it("rejects duplicated canonical tags and missing responsive resources", () => {
    expect(validate(html + '<link rel="canonical" href="https://alook.ai/blog/example">').join()).toContain("canonical");
    expect(validate(html.replace('alt=""', 'alt="" srcset="/blog/_generated/missing.webp 480w"')).join()).toContain("responsive image");
  });
  it("rejects an explicitly blank seoTitle at source validation", () => {
    expect(readBlogMetadata('export const metadata = { seoTitle: "   " }', "example").errors.join()).toContain("seoTitle");
  });
});

vi.mock("../src/lib/blog/topics", () => ({ blogTopics: [{ entries: [{ slug: "example" }] }] }));

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

describe("Blog build gate", () => {
  it("checks the built article and discovery outputs, including draft leaks", () => {
    const root = mkdtempSync(join(tmpdir(), "blog-build-gate-"));
    const put = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
    const source = (data: Record<string, unknown>) => `export const metadata = {${Object.entries(data).map(([key,value]) => `${key}: ${JSON.stringify(value)}`).join(",")}};`;
    try {
      put("src/content/example.mdx", source(metadata));
      put(".next/server/app/blog/example.html", html);
      put("src/lib/blog/image-assets.json", JSON.stringify(assets));
      put("src/lib/blog/redirects.json", "[]");
      put("public/blog/example/hero.webp", "fixture resource");
      const { readingTime: _readingTime, image: _image, ...discoveryPost } = metadata;
      put(".next/server/app/internal/blog-discovery.body", JSON.stringify({ version: 1, posts: [discoveryPost] }));
      put(".next/server/app/blog/feed.xml.body", "<rss><channel><item><link>https://alook.ai/blog/example</link></item></channel></rss>");
      put(".next/server/app/blog.html", '<a href="/blog/example">Example</a>');
      expect(() => validateBlogBuild(root)).not.toThrow();
      put(".next/server/app/blog/example.html", html.replace("<h1>Example</h1>", ""));
      expect(() => validateBlogBuild(root)).toThrow("one H1");
      put(".next/server/app/blog/example.html", html);
      put(".next/server/app/blog.html", '<a href="/blog/draft">Draft</a>');
      expect(() => validateBlogBuild(root)).toThrow("Blog index differs");
      put(".next/server/app/blog.html", '<a href="/blog/example">Example</a>');
      put("src/content/draft.mdx", source({ ...metadata, slug: "draft", draft: true }));
      expect(() => validateBlogBuild(root)).not.toThrow();
      put(".next/server/app/blog/draft.html", html);
      expect(() => validateBlogBuild(root)).toThrow("Draft was prerendered");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
