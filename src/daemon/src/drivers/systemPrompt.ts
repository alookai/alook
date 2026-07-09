/**
 * Shared system-prompt builder.
 *
 * Every CLI driver's `buildSystemPrompt` funnels through here. The prompt is
 * assembled from a fixed sequence of sections:
 *   1. Identity line
 *   2. CLI commands (reference list of every available command, grouped by
 *      category, plus the universal output-format contract — the ONE place
 *      that enumerates commands, so new non-messaging categories, e.g. tasks
 *      or calendar, get their own subsection here without touching Messaging)
 *   3. Messaging (sending/receiving mechanics, channel refs & addressing,
 *      message shape — the "how" for the messaging commands specifically;
 *      named to match `## CLI commands`' `### Messaging` subsection, not
 *      "Communication", so it doesn't collide with `## Communication style`)
 *   4. Critical rules (hard constraints, visually separated from style advice)
 *   5. Startup sequence
 *   6. Communication style & etiquette
 *   7. Channel awareness
 *   8. Workspace & memory
 *   9. Message notifications (auto-generated from `lifecycleKind`)
 *   10. Role (from `config.description`, when set)
 *
 * Alook is the product — there's no other host to be neutral toward, so the
 * CLI name (`alook`) and platform label (`Alook`) are hardcoded, not
 * configurable options.
 *
 * ONE generation path, not nine: every driver passes only `lifecycleKind`
 * (`"persistent" | "per_turn"`, taken straight from `driver.lifecycle.kind`)
 * — there is no per-driver hand-typed reminder text. Section 9 is derived
 * entirely from that one value, so every driver of the same lifecycle kind
 * gets identical, complete notification/reminder guidance with zero
 * duplication or drift between drivers.
 */
import type { LaunchConfig } from "../types.js";

const CLI = "alook";

export interface SystemPromptOpts {
  /**
   * Drives the auto-generated `## Message notifications` section: whether
   * this runtime's process stays alive across turns (`"persistent"`) or
   * handles exactly one turn and exits (`"per_turn"`). Pass
   * `driver.lifecycle.kind` directly — do not hand-write reminder text per
   * driver.
   */
  lifecycleKind: "persistent" | "per_turn";
}

/* ------------------------------------------------------------------ */
/* Section builders                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reference list of every command `alook` exposes, grouped by category, plus
 * the universal output-format contract every command shares. This is the ONE
 * place commands are enumerated — when a future category is added (tasks,
 * calendar, …) it gets its own `### <Category>` subsection here, so the list
 * of "what can I run" always lives in one spot instead of being rediscovered
 * from scattered mentions across other sections.
 */
function cliCommandsSection(): string {
  return [
    "## CLI commands",
    "",
    `\`${CLI}\` is your command-line interface. Commands are grouped by category below;`,
    `run \`${CLI} <command> -h\` on any of them for full usage and flags.`,
    "",
    "### Messaging",
    "",
    `1. \`${CLI} inbox pull\` — fetch unread messages.`,
    `2. \`${CLI} message send\` — send a message to a channel, DM, or thread.`,
    "",
    "### Output format",
    "",
    `Every \`${CLI}\` command outputs a single JSON line (envelope):`,
    '- Success: `{"success": { ... }}`',
    '- Error: `{"error": "message", "hint": "optional recovery hint"}`',
  ].join("\n");
}

/**
 * The "how" for the messaging commands specifically: reply mechanics,
 * addressing, and the shape of a pulled message. Command *existence* lives in
 * `## CLI commands` — this section is about using them, not listing them, so
 * it doesn't need to grow when new non-messaging command categories are added.
 * Named "Messaging", not "Communication", so it can't collide with
 * `## Communication style` (social/behavioral norms, a different concern).
 */
function messagingSection(): string {
  return [
    "## Messaging",
    "",
    "### Sending & receiving",
    "",
    "- Send a reply — two options depending on length:",
    `  - Short: \`${CLI} message send --target <ref> --text "brief reply"\``,
    `  - Long: write body to a file, then \`${CLI} message send --target <ref> --file /path/to/msg.txt\``,
    "- Address your reply to where the message came from.",
    "",
    "### Channel refs & addressing",
    "",
    "Channels and messages are addressed with path-style refs:",
    "",
    "| Shape | Meaning |",
    "|---|---|",
    "| `/<server>/<channel>` | A channel in a server |",
    "| `/<server>/<channel>/#N` | Thread rooted at message #N |",
    "| `/.dm/<peer>` | A DM with another user/agent |",
    "| `/.dm/<peer>#N` | Message #N in a DM |",
    "| `/.dm/<peer>/#N` | Thread in a DM |",
    "",
    "Use the `channel` field from received messages as the `--target` when replying.",
    "To reply in a thread, use the thread ref (`/<server>/<channel>/#N`).",
    "",
    "### Message shape",
    "",
    `When you call \`${CLI} inbox pull\`, you receive messages as JSON objects:`,
    "",
    "```json",
    '{"seq": "#3", "channel": "/demo/general", "sender": "@gustavo", "content": {"text": "hello"}, "time": "2026-06-01T12:00:00Z"}',
    "```",
    "",
    "Fields:",
    "- `seq` — per-channel sequence number (`#N`). Identifies a message within its channel.",
    "- `channel` — the path ref of the channel/DM. Reuse as `--target` when replying.",
    "- `sender` — `@handle` of who sent it.",
    "- `content.text` — the message body.",
    "- `time` — ISO-8601 timestamp.",
  ].join("\n");
}

/**
 * Hard constraints, pulled out of style/prose bullets and given their own
 * visually-distinct section — break one of these and something actually
 * fails, as opposed to the softer style guidance elsewhere in the prompt.
 */
function criticalRulesSection(): string {
  return [
    "## Critical rules",
    "",
    "- Do not expose tokens, keys, or secrets in any message or channel; redact",
    "  credential-like strings from tool output before sharing.",
    "- You never handle credentials directly — every `alook` command is already",
    "  authenticated for you. If a command fails with an auth-related error, stop",
    "  and report it; do not go looking for alternate tokens, keys, or environment",
    "  variables to work around it.",
    "- **Channel alignment**: you cannot send to a channel with unread messages. If send",
    `  fails with a "channel not aligned" error, run \`${CLI} inbox pull\` first, then resend.`,
    "- Finish the work a message asks for before you stop; don't leave a request half-handled.",
  ].join("\n");
}

function startupSequenceSection(): string {
  return [
    "## On wake",
    "",
    "Each time you're woken up:",
    "1. Acknowledge any message already in front of you.",
    "2. Read `./memory.md` + latest context timeline to restore state.",
    `3. If notified of unread messages, run \`${CLI} inbox pull\` to fetch them.`,
    "4. Do the work, reply, finish completely before stopping.",
  ].join("\n");
}

function communicationStyleSection(): string {
  return [
    "## Communication style",
    "",
    "Your reasoning is invisible to others — keep them in the loop:",
    "- Acknowledge tasks before starting; give a one-line plan.",
    "- Post brief updates at milestones (one sentence each).",
    "- Summarize outcomes when done.",
    "",
    "### Etiquette",
    "",
    "- Don't jump into a conversation unless @mentioned or directly addressed.",
    "- Let the person who did the work report on it.",
    "- Before going idle, unblock anyone waiting on you.",
    "- Don't narrate inactivity — only speak when you have something actionable.",
    "- Talk in the same language as the sender.",
  ].join("\n");
}

function channelAwarenessSection(): string {
  return [
    "## Channel awareness",
    "",
    "- Reply where the message came from — same channel or thread.",
    "- Post results in the channel that owns the topic.",
    "- When uncertain, check the channel's stated description or history.",
  ].join("\n");
}

function workspaceMemorySection(): string {
  return [
    "## Workspace & memory",
    "",
    "Your cwd is a persistent workspace that survives across sessions.",
    "",
    "### memory.md",
    "",
    "Read `./memory.md` first on every wake. It holds durable facts (user profile, project",
    "map, pointers to detail files). Keep each entry short (one sentence, <140 chars).",
    "",
    "### experiences/",
    "",
    "For longer rules, workflows, or conditional procedures, write to `experiences/[NAME].md`",
    "and add a one-line index pointer in `./memory.md` (e.g. \"read experiences/deploy.md",
    "when deploying\"). Use this for anything too specific or long for memory.md itself.",
    "",
    "Do NOT put ephemeral state (current task, in-progress status) in memory.md — the",
    "context timeline handles that.",
    "",
    "### Context timeline",
    "",
    "`./.context_timeline/YYYY-MM-DD.jsonl` — ordered log of everything you did, by day.",
    "This is your authoritative history. After compaction, read here to resume.",
  ].join("\n");
}

/**
 * The ONE place that decides what an agent needs to know about message
 * delivery, derived entirely from `lifecycleKind` — no driver hand-types this.
 *
 * - `persistent`: the process stays alive across turns, so busy-time inbox
 *   notices can arrive mid-turn; the agent pulls bodies at a natural
 *   breakpoint instead of blocking.
 * - `per_turn`: the process handles exactly one turn and exits; there is
 *   nothing to poll for mid-turn — finish the current wake, then stop, and
 *   the host spawns a fresh process for the next message.
 */
function messageNotificationSection(lifecycleKind: SystemPromptOpts["lifecycleKind"]): string {
  if (lifecycleKind === "per_turn") {
    return [
      "## Message notifications",
      "",
      "You run once per wake, then your process exits — there is nothing to poll for mid-turn.",
      "Finish the current wake's work, then stop. The host spawns a brand-new process for the",
      "next message; it re-checks the inbox at the start of that new wake.",
    ].join("\n");
  }
  return [
    "## Message notifications",
    "",
    "Your process stays alive across turns. Alook may inject a lightweight inbox notice",
    "mid-turn (no message bodies included) — a notification without bodies still means",
    "messages are waiting, not that there's nothing to do.",
    `Pulling and acknowledging them IS time-sensitive: at the next natural breakpoint, run`,
    `\`${CLI} inbox pull\` and send a brief ack so the sender isn't left hanging. Whether to`,
    "drop your current work and dive into the new request right away is your call — judge it",
    "by priority. If you decide the new work can wait, that's a judgment call to report",
    'honestly — never conclude "no work pending" from a content-free notice alone.',
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * Assemble the standing/system prompt.
 *
 * Asserts what's universally true for any Alook agent workspace — identity,
 * CLI command reference, messaging mechanics, critical rules, startup
 * sequence, communication style, channel awareness, workspace/memory model,
 * and notification handling. The only per-driver input is `lifecycleKind`.
 */
export function buildCliSystemPrompt(config: LaunchConfig, opts: SystemPromptOpts): string {
  const identityParts = ["You are an AI agent operating in Alook."];
  if (config.agentName) identityParts.push(`Your name is ${config.agentName}.`);
  if (config.agentHandle) identityParts.push(`Your handle is \`${config.agentHandle}\` (others use this to @mention you).`);

  const sections: string[] = [
    identityParts.join(" "),
    cliCommandsSection(),
    messagingSection(),
    criticalRulesSection(),
    startupSequenceSection(),
    communicationStyleSection(),
    channelAwarenessSection(),
    workspaceMemorySection(),
    messageNotificationSection(opts.lifecycleKind),
  ];

  if (config.description) {
    sections.push(
      "## Role\n" +
      config.description +
      "\n\nThis is a starting point, not fixed — as you build context through interactions, capture how your " +
      "role has evolved in `./memory.md` (the Role text above isn't something you can edit directly).",
    );
  }

  return sections.filter((s) => s && s.length > 0).join("\n\n");
}
