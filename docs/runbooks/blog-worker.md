# Blog Worker

The public Blog is a nested Next/OpenNext app in `src/web/blog` and deploys as the independent `alook-blog` Worker. The main `alook-web` build deliberately contains no Blog routes, MDX, or post assets.

## Local development

From the repository root, `pnpm dev:web` starts one browser origin at `http://127.0.0.1:3000`. The development-only ingress sends `/blog*` and `/og/blog*` to the Blog backend on 3002 and everything else to main on 3001. Use `pnpm --filter @alook/web dev:main` or `dev:blog` only for direct backend debugging.

After both OpenNext artifacts exist, `pnpm --filter @alook/web dev:zones:worker` runs the two local Workers behind the same ingress.

## Build contracts

- Main only: `pnpm --filter @alook/web build`
- Blog only: `pnpm --filter @alook/web build:blog`
- Blog content validation: `pnpm --filter @alook/web validate:blog`
- Blog binding/output audit: `pnpm --filter @alook/web verify:blog-dry-run`
- Cross-zone output audit: `pnpm --filter @alook/web verify:zone-output`

`blog/shared-build-inputs.json` is the source of truth for canonical Web files consumed by the Blog build. Binary inputs are copied into ignored build inputs and verified byte-for-byte before every Blog build.

## Runtime ownership

Cloudflare route patterns `alook.ai/blog*` and `alook.ai/og/blog*` belong directly to `alook-blog`. The `BLOG_WORKER` service binding is used only by main's `/sitemap.xml` and `/llms.txt` handlers to fetch the versioned discovery manifest over Worker RPC. It must never proxy Blog pages or assets.

Production discovery is fail-closed: an unavailable or invalid manifest yields `503` with `Cache-Control: no-store`. The packaged self-host app removes `BLOG_WORKER` and sets `BLOG_DISCOVERY_REQUIRED=false`, producing deterministic main-only discovery documents.

## Deployment safety

Building and dry-running are safe local operations. Uploads, route attachment, Worker deployment, and rollback mutate Cloudflare state and require the separately approved cutover procedure and an explicitly designated operator. Do not use the Blog deploy/upload scripts during ordinary implementation or review.
