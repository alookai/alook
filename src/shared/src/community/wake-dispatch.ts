import { nanoid } from "nanoid";
import type { HostCommand, UnreadNotice } from "../community-cli-contract";
import { makeRuntimeConfig } from "../runtime-config";
import { formatHandle } from "../lib/discriminator";
import * as message from "../db/queries/community/message";
import * as bot from "../db/queries/community/bot";
import * as member from "../db/queries/community/member";
import * as readState from "../db/queries/community/read-state";
import * as agentInbox from "../db/queries/community/agent-inbox";
import type { Database } from "../db/index";

/**
 * Deliberately NOT `@cloudflare/workers-types`' `Fetcher` — this module is
 * imported (transitively, via the `@alook/shared` barrel) by non-Workers
 * consumers too (`@alook/cli`, `@alook/daemon`), whose tsconfigs don't
 * include `@cloudflare/workers-types` in `types`. A real `Fetcher` service
 * binding satisfies this structurally at the two real call sites
 * (`src/web`, `src/wake-worker`, both of which DO have workers-types).
 */
interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * One `WAKE_QUEUE` message — deliberately minimal (plan
 * minimal-wake-queue-unread-notice §1): just enough to rebuild the wake
 * command from CURRENT D1 state at consume time. No `machineId`, `runtime`,
 * `launchId`, message text, sender, or preview — all of that is re-derived
 * by `buildUnreadWakeCommand` in `src/wake-worker` so a stale queue item
 * never wakes an old machine or carries stale content.
 */
export interface WakePayload {
  messageId: string;
  botUserId: string;
}

/**
 * Thin wake-dispatch seam. Lives in `src/shared` (not `src/web`) because
 * BOTH the `src/web` wake producer AND the `src/wake-worker` queue consumer
 * need it, and the consumer has no `@opennextjs/cloudflare` / Next.js
 * context — this module does a plain `Fetcher.fetch`, nothing
 * CF-Workers-Next.js-specific.
 *
 * `env.WS_DO_WORKER` is a service binding to the `alook-ws-do` worker's HTTP
 * surface (never a raw DO namespace — `src/web`/`src/wake-worker` cannot
 * fetch a DO stub directly). This function POSTs an already-fully-built
 * `HostCommand` to that worker's `/community-machine/by-id/<machineId>/forward-agent-wake`
 * route and normalizes the response to a boolean — it never inspects,
 * validates, or constructs any part of `command`, and it never exposes the
 * DO-naming mechanics (no public `getMachineDoName` here or anywhere else).
 *
 * Error contract (load-bearing for the queue consumer's retry semantics):
 * - `{ sent: true }` — at least one live doName's DO forwarded the command
 *   to an authenticated daemon WebSocket.
 * - `{ sent: false }` — the ws-do route responded 200 with `{ sent: 0 }`:
 *   no active credential for this machine, or a live credential but no open
 *   WS (daemon offline). This is a known-permanent state for this attempt —
 *   the consumer must `ack()`, not `retry()`. Daemon reconnect warmup
 *   recovers on its own.
 * - throws — the ws-do route (or the service-binding fetch itself) returned
 *   non-2xx, or the fetch itself threw (network error/timeout). This is
 *   transient — the consumer must `retry()`. Never swallowed into
 *   `{ sent: false }`, or a real outage would look identical to "daemon is
 *   just offline" and stop retrying.
 */
export async function sendWakeToMachine(
  env: { WS_DO_WORKER: FetcherLike },
  machineId: string,
  command: HostCommand
): Promise<{ sent: boolean }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-wake`;
  const res = await env.WS_DO_WORKER.fetch(`http://internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    throw new Error(`sendWakeToMachine: ws-do route returned ${res.status} for machine ${machineId}`);
  }

  const data = (await res.json()) as { sent?: number };
  return { sent: (data.sent ?? 0) > 0 };
}

/** Why `buildUnreadWakeCommand` decided NOT to wake — every reason is a permanent, current-state miss the consumer must `ack()`, never `retry()`. */
export type SkipReason =
  | "message_missing"
  | "invalid_message_scope"
  | "self_authored"
  | "bot_missing"
  | "bot_deleted"
  | "bot_unbound"
  | "bot_not_in_scope"
  | "notice_channel_unresolvable"
  | "already_read";

export type BuildUnreadWakeResult =
  | { state: "ready"; machineId: string; command: HostCommand }
  | { state: "skip"; reason: SkipReason };

/**
 * Rebuild an `agent:wake` `HostCommand` from CURRENT D1 state — the queue
 * consumer's core orchestration (plan minimal-wake-queue-unread-notice §3/§4).
 * Re-checks the message, the bot's binding, the bot's current access to the
 * message scope, and the bot's read-state before waking, so a stale queue
 * item (membership revoked, bot rebound to a new machine, already caught up
 * via an earlier `inboxPull`) never produces a bogus or wasted wake.
 *
 * Every `skip` reason here is a PERMANENT current-state miss — the caller
 * `ack()`s the queue message. D1 exceptions propagate (thrown, not
 * returned) so the caller can `retry()` instead.
 */
export async function buildUnreadWakeCommand(
  db: Database,
  input: { messageId: string; botUserId: string }
): Promise<BuildUnreadWakeResult> {
  const msg = await message.getWakeMessageScopeById(db, input.messageId);
  if (!msg) return { state: "skip", reason: "message_missing" };

  const scope = msg.channelId
    ? { channelId: msg.channelId }
    : msg.dmConversationId
      ? { dmConversationId: msg.dmConversationId }
      : null;
  if (!scope) return { state: "skip", reason: "invalid_message_scope" };

  // Producer filtering already excludes self-wakes; the consumer must still
  // be robust to malformed/internal queue items that point a bot at its own
  // message.
  if (msg.authorId === input.botUserId) return { state: "skip", reason: "self_authored" };

  const botCtx = await bot.getBotWakeContext(db, input.botUserId);
  if (botCtx.state !== "ready") return { state: "skip", reason: botCtx.state };

  const canRead = await member.canBotReadWakeScope(db, input.botUserId, scope);
  if (!canRead) return { state: "skip", reason: "bot_not_in_scope" };

  const lastReadSeq = await readState.getWakeReadSeq(db, input.botUserId, scope);
  if (lastReadSeq >= msg.seq) return { state: "skip", reason: "already_read" };

  const channel = await agentInbox.resolveUnreadNoticeChannel(db, scope, input.botUserId);
  if (!channel) return { state: "skip", reason: "notice_channel_unresolvable" };

  const unreadNotice: UnreadNotice = { kind: "unread_notice", channel, latestSeq: msg.seq };
  const config = makeRuntimeConfig({
    runtime: botCtx.runtime,
    agentName: botCtx.name,
    agentHandle: `@${formatHandle(botCtx.name, botCtx.discriminator)}`,
  });
  const command: HostCommand = {
    type: "agent:wake",
    agentId: botCtx.botUserId,
    config,
    launchId: nanoid(),
    unreadNotice,
  };
  return { state: "ready", machineId: botCtx.machineId, command };
}

/** Outcome of resolving ONE wake candidate — what every caller (the real queue consumer, and the dev-only inline stand-in) needs to decide what to log. */
export type DispatchOneWakeResult =
  | { outcome: "skip"; reason: SkipReason }
  | { outcome: "sent" }
  | { outcome: "delivered_nowhere"; machineId: string };

/**
 * The ONE place that decides what happens for a single `{ messageId,
 * botUserId }` wake candidate: rebuild from current D1 state, and forward if
 * `ready`. Every caller — `src/wake-worker`'s real queue consumer AND
 * `src/web`'s dev-only inline stand-in (local Cloudflare Queues can't bridge
 * separate `wrangler dev`/`next dev` processes, so `next dev` calls this
 * directly instead of going through `WAKE_QUEUE`) — calls this SAME function,
 * so "what a wake candidate resolves to" has exactly one implementation.
 * Callers own their own retry/ack-vs-log semantics on top; this never
 * swallows a `buildUnreadWakeCommand`/`sendWakeToMachine` throw (a transient
 * D1/network failure) — it propagates so the caller can retry.
 */
export async function dispatchOneUnreadWake(
  db: Database,
  env: { WS_DO_WORKER: FetcherLike },
  input: { messageId: string; botUserId: string }
): Promise<DispatchOneWakeResult> {
  const result = await buildUnreadWakeCommand(db, input);
  if (result.state === "skip") return { outcome: "skip", reason: result.reason };
  const { sent } = await sendWakeToMachine(env, result.machineId, result.command);
  return sent ? { outcome: "sent" } : { outcome: "delivered_nowhere", machineId: result.machineId };
}
