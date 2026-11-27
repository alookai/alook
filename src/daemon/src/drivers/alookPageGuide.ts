import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ALOOK_PAGE_GUIDE_FILENAME = "alook-page.md";

export const ALOOK_PAGE_GUIDE_CONTENT = [
  "# Alook Page Guide",
  "",
  "Use this guide to decide **when** to create an Alook Page instead of inline HTML or Markdown, and **which artifact `type`** to choose. For exact CLI commands and flags, see `### Pages` in `AGENTS.md`.",
  "",
  "## Choosing the right surface",
  "",
  "Keep these three surfaces strictly separate so users never get a heavy cloud app for a throwaway visual, or a dead static snapshot when they need a living artifact:",
  "",
  "| Surface | Use when | State & collaboration |",
  "|---|---|---|",
  "| Plain text / `.md` attachment | Plans, reviews, logs, summaries, code diffs | Read-only prose in chat |",
  "| Inline HTML (`[alook-html-preview](id)`) | One-off charts, diagrams, sequence flows, UI mockups, or interactive visuals that do not need persisted state | **Ephemeral** — may use local JS for filters/toggles/temp input, but saves no cloud state |",
  "| **Alook Page** (`--page <dir\\|id>`) | Living documents, decks, spreadsheets, whiteboards, dashboards, or apps that need persisted state and ongoing edits | **Persistent cloud state** — collaborative editing, durable storage, reusable across channels |",
  "",
  "Rule of thumb: if the user only needs a **one-off visual or client-only interactive snippet without saved state**, use Inline HTML. Use Alook Page only when the user needs **persisted state, ongoing collaboration, or a living artifact/app** they can reopen and keep editing after the chat moves on.",
  "",
  "## Artifact types",
  "",
  "Set `\"type\"` in the artifact directory's root `.artifact.json`. Pick a built-in collaborative editor whenever it fits; use `page` only when you need a custom HTML/CSS/JS app.",
  "",
  "| `type` | Purpose |",
  "|---|---|",
  "| `docs` | Multi-tab collaborative rich-text documents (specs, PRDs, briefs, meeting notes) |",
  "| `slides` | Collaborative slide decks and presentations |",
  "| `sheets` | Spreadsheets with formulas and tabular modeling |",
  "| `whiteboard` | Infinite-canvas whiteboards, architecture diagrams, brainstorming |",
  "| `design` | Vector and UI layout design boards |",
  "| `data` | Live data dashboards and interactive metric reports backed by datasets |",
  "| `motion` | Timeline motion graphics and short video compositions |",
  "| `design-system` | Brand and UI design systems (colors, typography, component tokens) |",
  "| `page` | Custom stateful multi-file HTML/CSS/JS interactive web app (requires root `index.html`) |",
  "",
  "## Directory format & live collaboration",
  "",
  "- **Required root manifest**: `.artifact.json` (UTF-8 JSON, max 64 KiB) with a supported `type` and concise `title`, e.g. `{\"type\":\"page\",\"title\":\"Launch Checklist\",\"capabilities\":{\"comments\":{}}}`.",
  "- **Generic `page`**: must include `index.html` at the directory root.",
  "- **Homepage cover image**: capture a real 16:10 screenshot of the Page's rendered homepage (PNG, JPEG, or WebP, max 2 MiB) so the message card displays the actual Page rather than a generic type fallback. Place it at `<dir>/cover.png` (or `preview.png`) in the artifact directory, or supply/update it through the cover commands in `### Pages` of `AGENTS.md`.",
  "- **Packaging & limits**: the CLI validates locally before upload, auto-excludes `.git`, `node_modules`, and `.DS_Store`, rejects symlinks and case/Unicode duplicate paths, and enforces 16 MiB compressed, 32 MiB unpacked, and 2,000 files max.",
  "- **One live resource across channels**: uploading once returns a `page_id`. Forwarding the same `page_id` to another channel links both cards to the same cloud Page without re-uploading. Deleting a message removes only that link; only the creator bot can permanently delete the Page.",
  "- **Editing safely with humans**: for built-in editors (`docs`, `slides`, `sheets`, etc.), query `{\"kind\":\"actions\"}` first and edit through native editor actions rather than raw file overwrites. For file writes (`{\"kind\":\"write\"}`), always `read` first and pass `if_match` with the returned etag so concurrent human edits are never clobbered.",
  "- **Comments**: reader comments posted from a Page return as normal messages in the exact conversation where the reader opened the card, mentioning that entry message's author bot.",
  "",
].join("\n");

export function syncAlookPageGuide(workingDirectory: string): boolean {
  if (!workingDirectory) return false;
  mkdirSync(workingDirectory, { recursive: true });
  const target = join(workingDirectory, ALOOK_PAGE_GUIDE_FILENAME);
  try {
    if (readFileSync(target, "utf8") === ALOOK_PAGE_GUIDE_CONTENT) return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  writeFileSync(target, ALOOK_PAGE_GUIDE_CONTENT, "utf8");
  return true;
}
