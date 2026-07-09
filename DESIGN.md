## Overview

This is the Alook design system. It is organized in layers: the **why** (context, principles), the **what** (foundations — color, type, spacing, elevation, shape, motion), the **how** (components, patterns), and the **words** (voice, do's & don'ts).

Light and dark are both first-class, and the app adapts across two breakpoints — **desktop** and **mobile**. Every token below resolves through CSS variables in `src/web/src/app/globals.css` — read values from there, never hard-code a hex or oklch in a component.

## Design Context

### Users
Power users and tasteful hackers who want Your Personal Company with a minimalist, collaborative approach. They value control over their infrastructure, appreciate good tooling, and have strong aesthetic sensibilities. They use Alook in focused work sessions — managing agents, reviewing task output, and iterating on instructions.

### Brand Personality
**Warm, precise, and utilitarian.** Alook feels like a well-crafted tool made by someone who cares — not cold and corporate, not flashy and consumer. It earns trust through restraint and clarity. Every element has a reason.

3-word personality: **Warm. Sharp. Purposeful.**

Emotional goals: confidence, calm focus, quiet delight in small details.

### Aesthetic Direction
**Visual tone**: Notion-inspired warmth meets developer-tool precision. Soft neutral palette (warm grays, cream tints) with crisp typography and intentional micro-interactions. Light and airy in light mode, cozy and focused in dark mode.

**References**: Notion (polished, warm, delightful micro-interactions), vintage Macintosh product photography (warm object on cool ground, generous negative space, matte textures)

**Anti-references**:
- Generic SaaS dashboards (blue buttons, card grids, cookie-cutter layouts)
- AI chatbot UIs (ChatGPT-style centered chat with big rounded bubbles and gradients)
- Playful/consumer apps (bright colors, illustrations, emoji-heavy, gamification)

**Theme**: Both light and dark as first-class citizens. Warm-tinted neutrals in both modes — never pure gray.

## Design Principles

1. **Every pixel earns its place** — No decorative filler. If an element doesn't help the user accomplish their goal, remove it. Whitespace is a feature, not wasted space.

2. **Warm precision** — Technical doesn't mean cold. Use warm color tints, generous spacing, and thoughtful transitions to make the tool feel human without being cute.

3. **Progressive disclosure** — Start simple, reveal depth through interaction. The interface should feel approachable on first use and powerful on the hundredth.

4. **Motion with meaning** — Animate state changes to orient the user, not to impress. A well-timed 200ms transition beats a flashy 2-second animation.

5. **Respect the craft** — This is a tool for people who appreciate good tools. Match the quality they expect from their best CLI utilities — fast, predictable, and delightful in the details.

## Foundations

The token values below are the source of truth recorded in prose. The live definitions live in `globals.css` (`:root` for light, `.dark` for dark). When they disagree, `globals.css` wins — update this doc to match, don't fork the values.

### Color

Inspired by vintage Macintosh product photography — a warm cream object on a dusty periwinkle ground, matte textures, even lighting, and nothing competing for attention.

**Lessons**

- **Temperature contrast over color variety** — One warm tone (cream/beige) against one cool tone (muted blue) creates more visual interest than five harmonious colors. Limit the palette, let temperature do the work.
- **Desaturated > saturated** — Dusty, powdery, slightly muted tones feel confident and timeless. Fully saturated colors feel loud and cheap. When picking any accent, pull it 20-30% toward gray.
- **Matte everything** — Avoid glossy effects, specular highlights, and glass-morphism. Matte surfaces feel tactile, calm, and honest. Shadows should be soft and diffuse, never sharp or dramatic.
- **Generous negative space is the luxury** — One element with room to breathe feels more expensive than ten elements packed together. When in doubt, add space, not content.
- **Nostalgia as warmth, not kitsch** — Reference the feeling of early personal computing (optimism, simplicity, human scale) without literal retro styling. Warm tints and rounded-but-not-bubbly shapes evoke this without cosplaying the past.

**The system in practice** — all neutrals sit in the warm hue band (oklch hue **60–80**). There is no neutral gray; "gray" is always tinted warm. Color carries meaning, not decoration: use a semantic token for what an element *is*, never a raw color value.

| Token | Role |
| --- | --- |
| `background` / `foreground` | Page surface and primary text. The warm cream-vs-near-black pair. |
| `card` / `popover` | Raised surfaces — slightly lighter (light) / lighter (dark) than `background`. |
| `primary` / `primary-foreground` | The single most important action or the strongest text. Solid warm fill. |
| `secondary` / `secondary-foreground` | Secondary surfaces and controls. |
| `muted` / `muted-foreground` | De-emphasized surfaces and supporting text. `muted-foreground` is the metadata/caption color. |
| `accent` / `accent-foreground` | Hover tint and gentle emphasis. |
| `border` / `input` / `ring` | Dividers, field outlines, and the focus ring. |
| `destructive` | Errors and irreversible actions only. Warm red — never repurpose it for emphasis. |
| `status-online` / `status-offline` | Presence dots only (green / red). Reserved — do not use as UI accents. |
| `sidebar-*` | Sidebar-scoped variants of the above, so the rail can read distinctly from content. |

Rules:
- **Pick tokens by intent, not by lightness.** Don't reach for `muted` because it "looks the right gray" — reach for it because the content is genuinely secondary.
- **Don't signal state by color alone.** Pair color with an icon, label, or weight change so colorblind users and high-contrast modes still read the state.
- **Accents stay desaturated.** Any new accent must be pulled 20–30% toward gray before it ships. Saturated leftovers from templates are bugs (see Do's & Don'ts).

### Typography

| Family | Token | Use |
| --- | --- | --- |
| DM Sans | `font-sans`, `font-heading`, `font-display` | UI, body, and headings — the default for nearly everything. |
| DM Mono | `font-mono` | Code, IDs, tabular data, terminal/CLI surfaces. |
| Literata | `font-news` | Long-form editorial / blog reading. |
| Caveat | `font-brand` | Sparingly — handwritten brand moments only. |
| VT323 | `font-crt` | Landing-page CRT nostalgia only. Never in the app. |

- **Base body** is `--text-base` (15px) at line-height 1.6. Body copy caps at ~65ch for readability.
- **Headings** tighten letter-spacing to -0.015em and ride shorter line-heights (h1 1.15 → h4 1.3). Size builds hierarchy; weight stays restrained (600, not 800).
- Apply families through the font tokens — don't hand-set `font-family`. Reach for size/weight changes only when hierarchy genuinely demands it; default to the base style.

### Layout & Spacing

Use a consistent three-step rhythm so spacing reads as intentional, not arbitrary:

- **8px within a group** (`gap-2` / `space-y-2`) — between tightly related elements (label and its input, icon and its text).
- **16px between groups** (`gap-4` / `space-y-4`) — between distinct clusters inside a section.
- **32–40px between sections** (`gap-8` / `space-y-8`) — between major regions of a page.

Whitespace is a feature, not wasted space (Principle 1). When a layout feels cramped, add space before you add structure. Reserve color and borders for when spacing alone can't carry the hierarchy.

**No half-step exceptions.** If a control feels wrong at 8/16/32, adjust the *control's* internal padding or the *container's* structure — don't reach for `px-5` (20px) or `py-2.5` (10px) as a middle-ground escape hatch. The only axis of variation is the breakpoint (`desktop` / `mobile`).

### Breakpoints

Two stages, not three. The split lives at **`640px`** — Tailwind's default `sm` breakpoint. Everything `<640` is **mobile**, everything `≥640` is **desktop**. This maps directly to `useBreakpoint()` in `src/web/src/hooks/use-mobile.ts` — pages read the resolved value and switch layout, they don't rewrite the query. `useIsMobile()` is a boolean shortcut for the common case.

| Stage | Range | Layout shape |
| --- | --- | --- |
| **Mobile** | `< 640px` | Single column with zone switching (`MobileZone = "nav" \| "messages"`). Back button in headers. Popovers may promote to sheets when they'd overflow. |
| **Desktop** | `≥ 640px` | Multi-column shells — server rail + channel/DM sidebar + main (in community), or app sidebar + workspace (elsewhere). Hover surfaces reveal actions. No back button in headers. |

Rules:
- **Read the breakpoint, don't guess.** Use `useBreakpoint()` (string) or `useIsMobile()` (boolean) for any behavior that must branch by stage. Don't sprinkle raw `window.innerWidth` checks or ad-hoc `matchMedia` calls — they drift away from the shared boundary and re-mount without SSR safety.
- **JS and CSS boundaries are the same 640px.** Use the hook for behavior (which zone to render, whether to show a back button); use Tailwind's `sm:` prefix for pure layout fit at the mobile ↔ desktop split. Both share the same 640px pivot so a mobile page never renders desktop CSS at the same width.
- **`md:` is banned. `lg:` is allowed only for desktop-internal fit** — e.g. an issue sheet that can float a timeline panel beside its body once the viewport clears ~1024px, or a stats grid that reflows from 1 col to 2 cols when there's room. This is not a third tier; it's a content-fit fallback that happens *within* desktop. If the switch changes navigation or a user-visible zone, it belongs in the JS hook, not in `lg:`.
- **Touch targets on mobile are non-negotiable.** Interactive elements ≥ 44×44px (`h-11`). On desktop the same control may collapse to `h-9`/`h-10`.
- **Don't introduce a third stage.** If a design "needs a tablet mode," either the mobile layout should stretch gracefully or the desktop layout should reflow inside — not a new tier.

### Dots & Indicators

Three status-dot sizes, each for a distinct role. Don't mix them.

| Size | Token | Role |
| --- | --- | --- |
| **6px** | `size-1.5` | Inline compact — inside a status pill, next to a tab label, or in a typing-dot animation. Small enough not to compete with adjacent text at `text-xs` / `text-[11px]`. |
| **8px** | `size-2` | Standalone unread / selection dot — sits at the end of a row or inside a radio-like control. Reads clearly at `text-sm` line height. |
| **10px** | `size-2.5` | Avatar presence badge — overlays the avatar corner and needs a `ring-background` halo to stay legible on any tint. |

Pair every dot with an icon or label change too — never signal state by color alone (see Do's & Don'ts).

### Elevation & Depth

Two matte shadow tokens, no more:

- `--e1` — resting lift (cards, raised surfaces). A barely-there 1px shadow.
- `--e2` — floating lift (popovers, menus, dialogs). A soft, diffuse drop.

Shadows are soft and diffuse, never sharp or dramatic (no hard offsets, no glow). Pair elevation with the matching radius family below. Prefer a tonal surface shift (`card` over `background`) to separate layers; use shadow only when an element genuinely floats.

### Shape

One radius family, scaled from `--radius`. Keep a single radius scale per view — don't mix a 6px control with an 18px sibling card.

- Controls and inputs → `radius-sm` / `radius-md`
- Cards and surfaces → `radius-lg`
- Menus, dialogs, large panels → `radius-xl` / `radius-2xl`
- Pills and avatars → fully round

Rounded-but-not-bubbly. The radius should soften an edge, not turn a button into a lozenge.

### Motion

**Motion with meaning** (Principle 4) — animate to orient the user, not to impress.

- **Duration**: 150ms for state changes (hover, color, opacity), ~200ms for popovers/disclosure, ~300ms for full overlays. If in doubt, shorter wins. Sometimes the snappiest choice is no animation at all.
- **Easing**: ease-out for entrances; the house curve is `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Reduced motion is mandatory.** Every animation must degrade gracefully under `prefers-reduced-motion: reduce` — this is already wired across `globals.css`; new animations must follow suit.

## Components

### Interaction states

State must be *visible*, and it must come from tokens — not ad-hoc tweaks. Every interactive element moves through:

- **Default** → base surface/border token.
- **Hover** → `accent` tint (or one step lighter/darker surface). 150ms transition.
- **Active / pressed** → one step beyond hover, so a click feels like it landed.
- **Disabled** → muted surface + `muted-foreground` text + `not-allowed` cursor. Never just lowered opacity on the whole control.
- **Focus** → a visible focus ring on `:focus-visible` using `ring`. Never remove an outline without a visible replacement — this is an accessibility requirement, not a style choice.

### Buttons & inputs

- **Primary** — solid `primary` fill, `primary-foreground` label. One per view, for the single most important action.
- **Secondary** — `background`/`secondary` surface with a `border`. The default workhorse.
- **Tertiary / ghost** — transparent, tints to `accent` on hover. For low-emphasis and inline actions.
- **Destructive** — `destructive` fill, reserved for irreversible actions; confirm before firing.
- Inputs use `input` for the border and `ring` for focus. Match the control's radius to the Shape scale.

## Patterns

### Progressive disclosure

Never show all options at once. Complexity exists but stays one interaction away.

- **Hover to preview** — hovering a linked page shows a preview without navigating. Tooltips appear contextually, not eagerly.
- **Click to expand** — sidebar tree nodes, dropdown menus, and kanban column options are collapsed by default. Expanded state is driven by user action, not by default.
- **Scrolling reveals depth** — additional features and settings appear as the user scrolls or explores. The first screen is always clean.

### Visual Harmony

Every pixel should reduce mental load, not add it. Whitespace, typography, and hierarchy aren't cosmetic — they're how brains process information.

- The UI should fade into the background. If a user notices the tool instead of their content, something is wrong.
- Aim for visual calm: Japanese minimalism, Bauhaus clarity. No decoration that doesn't serve comprehension.
- If a feature makes the interface more complicated without making it more powerful, cut it.

### Loading to Loaded Stability

The transition from loading to loaded must feel like a *reveal*, not a *rearrangement*. The user's eye should never lose its place.

**Core rule**: The loading skeleton and the loaded content must occupy the **same dimensions, position, and layout flow**. Nothing should jump, shift, or reflow when data arrives.

**Guidelines**

- **Reserve exact space** — Skeleton placeholders must match the height, width, and margin of the real content they replace. A skeleton card that is 20px shorter than the loaded card causes a visible pop.
- **Anchor scroll position** — If content loads above the viewport (e.g. prepending items), compensate scroll offset so the user's visible content stays pinned.
- **Fade, don't swap** — Use a short crossfade (150–200ms, ease-out) to transition from skeleton to content. Avoid hard cuts where a gray block snaps to text in a single frame.
- **Match structure, not just size** — Skeleton shapes should echo the content layout (e.g. a line for a title, a shorter line for metadata, a block for an avatar). Generic identical bars feel lazy and make the transition more jarring, not less.
- **No Cumulative Layout Shift (CLS)** — Treat any visible layout shift during load as a bug. Images must have explicit dimensions or aspect-ratio containers. Dynamic lists should use fixed-height rows or virtualized containers.
- **Empty states hold the frame** — When a section loads but has zero items, the empty state placeholder must fill the same region the skeleton occupied. Don't collapse the container.
- **Stagger gracefully** — If multiple sections load independently, each section transitions on its own timeline. One section loading should never cause another to reflow.
- **Avoid spinners as primary indicators** — Prefer inline skeletons over centered spinners. Spinners displace content and create a jarring before/after. Use spinners only for actions (button presses, form submissions) where there is no content to skeleton.

## Voice & Content

Words are part of the interface. They should sound like the brand: **warm, sharp, purposeful** — a capable peer, never a corporate assistant or a chirpy mascot.

- **Name actions by what they do** — verb + noun (`Send invite`, `Delete workspace`), never a bare `OK` / `Confirm` / `Submit`.
- **Errors say what happened and what to do next.** "Couldn't reach the agent — check it's running and retry." Not "An error occurred."
- **Confirmations are specific and quiet.** Name the thing that changed (`Workspace deleted`), drop the trailing period, and never say "successfully."
- **Write like a person, skip the filler.** No "please," no superlatives, no exclamation marks by default. Use real numerals, curly quotes, and the ellipsis character.
- **Empty states teach, not apologize.** Say what goes here and how to add the first one.
- **Match the surface.** Plain language in the UI; precise, literal language in anything CLI- or developer-facing.

## Do's & Don'ts

- **Do** pick tokens by intent (`muted` because it's secondary), not by how the color looks.
- **Do** keep WCAG AA contrast (4.5:1 for body text) in both light and dark.
- **Do** show a visible focus ring on every interactive element at `:focus-visible`.
- **Do** desaturate any new accent 20–30% toward gray before shipping.
- **Do** pair `overflow-y-auto` / `overflow-x-auto` with `thin-scrollbar` — always.
- **Don't** introduce a saturated or off-palette color. Template leftovers (e.g. a blue-violet sidebar token) are bugs to fix, not values to keep.
- **Don't** signal state by color alone — add an icon, label, or weight.
- **Don't** use glass-morphism, glossy highlights, or hard/dramatic shadows.
- **Don't** animate to impress, run animations over ~300ms, or skip the `prefers-reduced-motion` fallback.
- **Don't** hard-code colors, fonts, or radii in components — go through the tokens.
- **Don't** add a feature that makes the interface more complicated without making it more powerful.
