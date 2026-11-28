import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ALOOK_PAGE_GUIDE_FILENAME = "alook-page.md";

export const ALOOK_PAGE_GUIDE_CONTENT = [
  "# Alook Page Guide",
  "",
  "Use this guide whenever you create, preview, upload, share, edit, or delete an Alook Page.",
  "",
  "## Choosing the right surface",
  "",
  "| Surface | Use when | State & collaboration |",
  "|---|---|---|",
  "| Plain text / `.md` attachment | Plans, reviews, logs, summaries, code diffs | Read-only prose in chat |",
  "| Inline HTML (`[alook-html-preview](id)`) | One-off charts, diagrams, sequence flows, UI mockups, or client-only interactive snippets | **Ephemeral** — no persisted cloud state |",
  "| **Alook Page** | Living documents, decks, spreadsheets, whiteboards, design boards, dashboards, or custom apps that stay editable over time | **Persistent cloud state** — collaborative editing, reusable across channels |",
  "",
  "## Artifact types",
  "",
  "Pick a built-in collaborative editor whenever it fits; use `page` only when you need a custom HTML/CSS/JS app.",
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
  "| `page` | Custom stateful multi-file HTML/CSS/JS interactive web app (requires root `.artifact.json` + `index.html`) |",
  "",
  "## CLI commands",
  "",
  "### Local authoring, visual check, and upload",
  "",
  "1. `$ALOOK_CLI page guide [--type <type>] [--ref <file>]` — ensure the shared local Open Artifact runtime (`~/.alook/page-runtime/`) and read the official `SKILL.md` / `reference/*.md` authoring spec for any of the 9 types. Always read the target type's guide before authoring a built-in artifact.",
  "2. `$ALOOK_CLI page local <command> [args...]` — run native local Open Artifact authoring and validation commands (`create`, `update`, `read`, `batch`, `write-db`, `read-db`, `check`, `generate`, `upload`, `info`) on your local artifact directory; forwards piped stdin (e.g. `- <<'EOF'`) and all upstream flags verbatim.",
  "3. `$ALOOK_CLI page preview --dir <dir> --out <img.png>` — render your local artifact directory (all 9 types) at 16:10, save a screenshot to `--out` for visual inspection before upload, and automatically stop the temporary browser and local server on exit.",
  "4. `$ALOOK_CLI page upload --dir <dir> [--cover <img-path>]` — validate and auto-zip the local directory (auto-detects built-in markers like `doc/doc.json`, `sheet/sheet.json`, `project/deck.json`, `db/board/meta.json` or root `.artifact.json`; generic `page` requires `.artifact.json` + `index.html`; auto-excludes `.git`, `node_modules`, `.DS_Store`, `_agent`; rejects symlinks; limits: 16 MiB compressed, 32 MiB unpacked, 2,000 files), capture its 16:10 homepage cover locally before any network call (or upload `--cover <img-path>`, PNG/JPEG/WebP, ≤ 2 MiB), and return its reusable `page_id`.",
  "",
  "### Sharing, listing, live editing, and deleting cloud Pages",
  "",
  "5. `$ALOOK_CLI message send --target <ref> --page <page_id> --remind-after <0|Nm|Nh> --stdin` — attach or forward an uploaded `page_id` across channels without re-uploading (all linked cards share one live cloud Page; reader comments return to the opening conversation).",
  "6. `$ALOOK_CLI page list [--limit <1..100>] [--cursor <cursor>]` — list Pages created by this bot (including unused uploads) with `total` and each Page's `messageCount`.",
  "7. `$ALOOK_CLI page --id <id> --stdin [--out <path>]` — read or live-edit an accessible cloud Page via JSON on stdin: `{\"kind\":\"manifest\"}`, `{\"kind\":\"read\",\"path\":\"...\"}` (use `--out` to write locally), `{\"kind\":\"write\",\"writes\":[{\"path\":\"...\",\"content\":\"<base64>\",\"if_match\":\"<etag>\"}]}` (use JSON `null` for `if_match` when creating a new file), `{\"kind\":\"actions\"}` (inspect native editor action schemas), or `{\"kind\":\"action\",\"name\":\"...\",\"args\":{...}}`.",
  "8. `$ALOOK_CLI page delete --id <id>` — permanently delete a Page created by this bot, destroy its cloud data and cover, and unlink all messages (deleting a message removes only that link).",
  "",
  "## Authoring rules & safe collaboration",
  "",
  "- **Read the type guide first**: never guess schemas for built-in types; fetch `SKILL.md` and `reference/*.md` via `page guide`.",
  "- **Use native tools for structured types**: `docs` and `sheets` must be authored through `page local` commands (never hand-edit `doc/doc.json` or `sheet/edits.jsonl`), and `whiteboard`, `data`, and `motion` use `page local write-db` + `page local check`.",
  "- **Visually verify before upload**: run `page preview --dir <dir> --out preview.png` and inspect the rendered image to confirm layout, legibility, and calculated values before running `page upload`.",
  "- **Edit safely alongside humans**: for built-in editors, query `{\"kind\":\"actions\"}` and prefer native editor actions over raw file overwrites. For `{\"kind\":\"write\"}`, always `read` first and pass `if_match` with the returned etag so concurrent human edits are never clobbered.",
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
