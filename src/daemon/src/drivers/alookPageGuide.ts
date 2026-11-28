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
  "| **Alook Page** | Living documents, decks, spreadsheets, whiteboards, dashboards, or apps that need persisted state and ongoing edits | **Persistent cloud state** — collaborative editing, durable storage, reusable across channels |",
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
  "## Authoring workflow & live collaboration",
  "",
  "- **Read the type's official guide first**: never guess file layouts or schemas for built-in types (`docs`, `slides`, `sheets`, `whiteboard`, `design`, `data`, `motion`, `design-system`). Fetch the type's exact `SKILL.md` and `reference/*.md` via `page guide` in `AGENTS.md` (lazily cached once in `~/.alook/page-runtime/` and shared across all bots on this machine).",
  "- **Use native local tools for structured types**: `docs` and `sheets` must be authored through native local commands (never hand-editing `doc/doc.json` or `sheet/edits.jsonl`), and `whiteboard`, `data`, and `motion` use the native document store (`write-db` / `check`). Run native local commands via `page local` in `AGENTS.md`.",
  "- **Manifest & markers**: generic `page` requires root `.artifact.json` (`{\"type\":\"page\",\"title\":\"...\"}`) plus `index.html`. Built-in types are detected automatically from their native markers (`doc/doc.json`, `sheet/sheet.json`, `project/deck.json`, `db/board/meta.json`, etc.) or optional `.artifact.json`.",
  "- **Visual self-check & 16:10 homepage cover**: run `page preview --dir <dir>` to open an interactive local URL in a browser, or `page preview --dir <dir> --out preview.png` to inspect a rendered 16:10 screenshot before uploading. During `page upload`, the CLI captures the 16:10 homepage cover locally before any network upload (or accepts your verified preview image via `--cover`, PNG/JPEG/WebP, max 2 MiB).",
  "- **Packaging & limits**: the CLI validates locally before upload, auto-excludes `.git`, `node_modules`, `_agent`, and `.DS_Store`, rejects symlinks and case/Unicode duplicate paths, and enforces 16 MiB compressed, 32 MiB unpacked, and 2,000 files max.",
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
