# Publishing an Alook Blog article

Blog is an independently built Next.js/MDX app. Author articles in `src/content/<slug>.mdx` and keep their images in `public/blog/<slug>/`. Keep the existing article URL when revising a post; use the redirect registry for an intentional URL move.

## Required article elements

Use an exported JavaScript metadata object, **not YAML frontmatter**:

```mdx
export const metadata = {
  slug: "example-guide",
  title: "A clear title that describes the article",
  date: "2026-10-09",
  author: "Alook Team",
  excerpt: "A useful description of the question this article answers.",
  readingTime: "5 min read",
  image: "/blog/example-guide/hero.webp",
};

Answer the reader's question before expanding on it.

![Description of what the diagram communicates](/blog/example-guide/hero.webp)

## A descriptive section heading

Include useful explanations, evidence, and relevant links.
```

- Required metadata: `slug`, `title`, `date`, `author`, `excerpt`, `readingTime`. Slug must match the filename, using lowercase words separated by hyphens. Dates use valid `YYYY-MM-DD`; reading time uses `N min read`.
- Optional: `seoTitle` (nonempty when supplied), `dateModified`, `image`, `draft`, `agentSummary`. `seoTitle` changes search/social titles, not the visible H1. Set `dateModified` only for a substantive revision, never earlier than `date`.
- The template owns the single H1. Start body sections at `##`, then use `###` for subsections. Do not add another `# Title`.
- Register every published article once in `src/lib/blog/topics.ts`, with its real topic and reader job. A draft uses `draft: true` and must stay out of public discovery/navigation.
- Use valid article paths and existing heading fragments for internal links. Prefer links that help the reader over a required link count. When publishing, check whether a relevant older article should link to this one.

## Images and sharing

Use normal Markdown image syntax and an existing local `/blog/<slug>/...` URL. Supported source formats are PNG, JPEG, WebP and SVG. Each referenced source must be at most 2 MiB; this ceiling is not a recommended target. Keep whole-article image cost low, especially on mobile. Preserve legibility in screenshots and diagrams.

Use meaningful alt text for informative images. An explicitly empty alt is appropriate only for a decorative image. Do not put keywords into alt text just to influence search.

The build reads real dimensions and generates `src/lib/blog/image-assets.json`; do not hand-edit this manifest. It also generates responsive WebP files in `public/blog/_generated/` (gitignored). The MDX transform emits width/height, responsive sources and decoding hints. The first body image loads eagerly; subsequent images are lazy. Put the intended leading image first. Explicit JSX image markup must meet the same rendered requirements; ordinary Markdown is the supported default.

The OG metadata uses the same asset dimensions as the article. Without `metadata.image`, the existing `/og/blog/<slug>` route supplies a generated sharing image. Do not declare a fixed 1200×630 size for a differently sized source file. Check the final sharing image, not just the metadata string.

## What Blog build checks

From the repository root, run:

```sh
pnpm --filter @alook/web build:blog
```

This includes source validation, image preparation, Next compilation, and rendered article validation before Worker packaging. `build:blog:next` is the internal Next/standalone preparation step used by that command. `validate:blog` alone checks source files; it is not the full publishing gate.

Build errors include missing/invalid required metadata, invalid optional SEO title, duplicate H1 in Markdown, invalid/missing/oversized source images; then, in rendered articles: missing body/title/description, a missing or extra H1, incorrect canonical, noindex, duplicate heading IDs, conflicting/unparseable BlogPosting JSON-LD, missing local article/fragment/image resources, and inconsistent image or OG dimensions. Generated responsive resources must exist. Drafts must not become prerendered public articles. The published article set must match topics, the built index, RSS and discovery manifest (the manifest supplies the main site sitemap).

The existing topic tests compare published MDX and the topic registry in both directions. Run related tests when changing templates or publication behavior; negative fixtures must demonstrate that invalid output actually fails. Keep `image-assets.json` regenerated with any source-image change so a clean checkout can typecheck before its first build.

## Editorial review is still required

These checks do not evaluate truth, search intent, image legibility or originality. Before publication:

1. State which reader question the article answers and how it differs from existing posts; update an older post when that serves readers better.
2. Verify product steps against the current UI. Cite sources for external claims; distinguish tested behavior from documentation-based comparison, and record when volatile facts were checked.
3. Use a real person or team byline. Add author/reviewer context only when accurate. Do not invent expertise or refresh dates to simulate freshness.
4. Check long/multi-image articles at desktop and mobile sizes, including light and dark. Inspect image text, links, anchors and sharing metadata.
5. Follow the existing content and deployment ownership. After deployment, check the public article, images and discovery entries. A successful build or merge is not proof that production has updated.

Title/description length, related-link opportunities and article image budgets are editorial decisions, not fixed ranking rules. Do not pad keywords or add FAQs solely for rich results. Google no longer shows FAQ or HowTo rich results; retain structured data only when it describes real visible content. Review Search Console page/query data when available to prioritize updates; HTTP 200 does not prove indexing or ranking.

References: [Google Article metadata](https://developers.google.com/search/docs/appearance/structured-data/article), [Google image guidance](https://developers.google.com/search/docs/appearance/google-images), [Search feature updates](https://developers.google.com/search/updates).
