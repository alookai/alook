<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Blog publishing contract

Read [README.md](README.md) before adding or revising articles. It defines required metadata, images, links, editorial review, and the checks enforced by Blog build. Keep the documentation and build checks in sync when changing this contract.

## Guides placement

Same-topic content variants (for example, adapting one collaboration task to a different coding-agent combination) MUST use `tags: ["guides"]` in the exported MDX metadata. They belong in the supplementary `/guides` directory, not repeated entries in the main Blog. A genuinely new main-Blog topic needs an editorial explanation of its distinct reader question. Update an existing article when the answer is the same. See README.md for the publishing contract.
