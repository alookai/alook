# Local component workbench

This private workspace imports the real Web and Blog components. It uses Storybook's official Next/Vite adapter, the product styles and fonts, and the existing product specimen providers. It does not start the authenticated Web application or either Cloudflare Worker.

From the repository root:

```sh
pnpm install
pnpm dev:storybook
```

Open <http://127.0.0.1:6006/>. Startup prepares Blog responsive images through the existing Blog pipeline and the local HTML attachment through the product preview-bridge producer. Stop with Ctrl+C in the terminal that started it. Keep one service on this port; reuse that service for review and owner input.

## Finding examples

Start with **Catalog → Source catalog → Browse**. Search a source path or component name, filter Web/Blog and exposure type, then follow a link. Composition entries name the region that mounts the original component. Application bootstrap, pure providers/effects and server-generated images have explicit boundaries instead of fake visual examples.

The catalog covers non-test TSX under Web `src/components` and `src/app`, and Blog `src/components` and `src/app`. `catalog/mappings.json` is the explicit author declaration. `catalog/catalog.json` is generated from those declarations, the current source inventory and actual CSF exports. Neither file proves that a component has rendered or passed a check. Keep execution evidence separate, bound to the reviewed source and actual journeys.

```sh
pnpm --filter @alook/storybook catalog
pnpm --filter @alook/storybook catalog:check
pnpm --filter @alook/storybook typecheck
pnpm --filter @alook/storybook lint
pnpm --filter @alook/storybook build
```

`typecheck` also requires an up-to-date catalog with no pending/blocked declarations. New or removed product files require review of the explicit mapping. Do not assign visual coverage from an import graph.

## Controls and review tools

| Tool | Current behavior |
| --- | --- |
| Controls | Typed stories expose supported props. Compound views also have named state examples. |
| Actions | `storybook/test` callbacks record local events; they do not prove clipboard, backend or native success. |
| Theme | Toolbar switches the original light/dark tokens. It owns the forced DOM theme and synchronizes the original provider context through setTheme, so consumers such as the HTML bridge observe the same value. An embedded product theme button cannot override the toolbar. |
| Viewport | Freely select a preset or resize the preview. Stories do not lock a viewport global. |
| Autodocs | Available for focused component stories. Large specimen boards and whole pages use Canvas to avoid mounting many full applications together. |
| Accessibility | Official addon is enabled for inspection. No comprehensive a11y pass or automatic gate is declared. |
| Interactions | Local controls and real component handlers are available. There is no automated `play`-test or backend acceptance claim. |
| Measure/outline | Storybook's built-in preview tools are available through its toolbar. |
| MCP | Optional, not installed or connected. The official Preview addon and component manifest can be evaluated after the base workbench is qualified. |

## Data and network ownership

Existing `brand-visual` fixtures own their QueryClient and native community registry. `AccountFixtures` requests the supported demo account input; it does not create a production session. Stories dispose their original provider owners on unmount. Message text, identities, local fonts and image sources reuse product data where possible.

MSW intercepts the local auth session and named read fixtures. The preview session is anonymous; the viewer-qualified community examples use the existing `demo-gus` owner. Read envelopes use the actual Shared schemas. Fake machine versions, pricing and invite codes describe examples, not current service facts. The fake `storybook-local-invite` token cannot invite anyone.

Every unprovided request whose pathname starts with `/api/` returns 501 and logs `[Storybook fixture missing] METHOD PATH`. Other assets and JavaScript modules pass through. This boundary matters: a regular expression matching `/api/` anywhere also matches Vite source paths and breaks imports. Account writes, invite sending, machine updates and production persistence are not implemented by the fixtures. Supported callback stories only record Actions or local component state.

The original landing page's `/demo` iframe is redirected by the local development-server preset to the real CommunityDemo story. There is no second Web server. Storybook's official Next navigation mocks keep route operations inside the workbench; this does not validate real application routing.

## Blog and static output

Blog has separate stories and uses its actual `blog-shell` styling. Preview-level font ownership and reference-counted Blog document scopes avoid removing another Docs preview's appearance. Blog page loaders await the original page functions and wrap their actual layouts. Original MDX uses the Blog's remark/rehype options and MDX component provider. This is React-output preview, not a Blog Worker, RSC server, SEO response or production route check.

`dev` and `build` prepare the original responsive Blog variants in the ignored `src/web/blog/public/blog/_generated` directory. The development service mounts the actual Web public assets, Blog images and the workbench's small local attachment fixtures. The generated HTML attachment uses the original preview bridge and sandbox contract. The development-server preset runs before Storybook serves static files and sends the product HTML_PREVIEW_CSP response header; a static host must send the same header on /preview/attachment.html.

A static build additionally needs its host to rewrite `/demo` to `/iframe.html?id=web-pages-public-pages--community-demo&viewMode=story`; Development-server presets are not part of static output. Local development is the current acceptance target.

The local attachment fixtures cover supported display branches. They do not validate operating-system save dialogs, real media permissions, native bridges or external authentication.

## Configuration references

- [Official Next/Vite framework](https://storybook.js.org/docs/get-started/frameworks/nextjs-vite)
- [Controls and browsing](https://storybook.js.org/docs/get-started/browse-stories)
- [Interaction testing](https://storybook.js.org/docs/writing-tests/interaction-testing)
- [Accessibility testing](https://storybook.js.org/docs/writing-tests/accessibility-testing)
- [Optional MCP](https://storybook.js.org/docs/ai/mcp/overview)
- [pnpm package extensions](https://pnpm.io/10.x/settings#packageextensions)

The configuration uses the installed stable Storybook 10.6.6 API. It loads a lightweight Next config, the real Web PostCSS config and the real nested CommonJS selector dependency through Vite's optimizer. A post configuration hook selects Web's actual OpenTelemetry API package after the adapter's server-oriented alias. It does not define a fake `__dirname` or replace product observability.

The workspace declares the missing `next` peer for `@next/mdx@16.4.2`. Its configuration types then resolve through the consuming Web package, instead of an unrelated hoisted Next instance. This uses pnpm package metadata rather than a type cast or a manual dependency link.
