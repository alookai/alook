import type { HostCommand, UnreadNotice } from "../community-cli-contract";
import { makeRuntimeConfig } from "../runtime-config";
import { resolveModelConfig } from "./bot-model";
import { formatHandle } from "../lib/discriminator";
import { utcDayKey } from "../utils/day-key";
import * as message from "../db/queries/community/message";
import * as bot from "../db/queries/community/bot";
import * as member from "../db/queries/community/member";
import * as agentInbox from "../db/queries/community/agent-inbox";
import * as mention from "../db/queries/community/mention";
import * as botAuditLog from "../db/queries/community/bot-audit-log";
import * as notificationEligibility from "../db/queries/community/notification-eligibility";
import { policyAllows } from "../db/queries/community/notification-setting";
import { getUsersByIds } from "../db/queries/user";
import type { Database } from "../db/index";
import { parseAttemptedCountReceipt } from "../transport-receipt";

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

interface WakeDispatchEnv {
  WS_DO_WORKER: FetcherLike;
}

/**
 * Stable, opaque identity for one semantic unread wake. Queue retries and
 * daemon reconnect resync rebuild the command independently from D1, so a
 * random id here would turn one unread message into multiple commands. The
 * domain-separated digest avoids adding a command ledger without exposing the
 * internal message id through daemon logs or the agent launch environment.
 */
async function unreadWakeLaunchId(input: {
  botUserId: string;
  messageId: string;
}): Promise<string> {
  const identity = JSON.stringify([
    "alook:unread-wake:v1",
    input.botUserId,
    input.messageId,
  ]);
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(identity),
    ),
  );
  return `wake_${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One `WAKE_QUEUE` message — deliberately minimal (plan
 * minimal-wake-queue-unread-notice §1): just enough to rebuild the wake
 * command from CURRENT D1 state at consume time. No `machineId`, `runtime`,
 * `launchId`, message text, sender, or preview — all of that is re-derived
 * by `buildUnreadWakeCommand` in `src/wake-worker` so a stale queue item
 * never wakes an old machine or carries stale content. `launchId` is derived
 * deterministically from the bot/message tuple so retry and reconnect replay
 * retain one semantic command identity.
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
 * route and normalizes the attempted socket-write count to a boolean — it never inspects,
 * validates, or constructs any part of `command`, and it never exposes the
 * DO-naming mechanics (no public `getMachineDoName` here or anywhere else).
 *
 * Error contract (load-bearing for the queue consumer's retry semantics):
 * - `{ attempted: true }` — at least one live doName's DO attempted the command
 *   on an authenticated daemon WebSocket. This is not a daemon receipt.
 * - `{ attempted: false }` — the ws-do route responded 200 with `{ attempted: 0 }`:
 *   no active credential for this machine, or a live credential but no open
 *   WS (daemon offline). This is a known-permanent state for this attempt —
 *   the consumer must `ack()`, not `retry()`. Daemon reconnect warmup
 *   recovers on its own.
 * - throws — the ws-do route (or the service-binding fetch itself) returned
 *   non-2xx, or the fetch itself threw (network error/timeout). This is
 *   transient — the consumer must `retry()`. Never swallowed into
 *   `{ attempted: false }`, or a real outage would look identical to "daemon is
 *   just offline" and stop retrying.
 */
export async function sendWakeToMachine(
  env: { WS_DO_WORKER: FetcherLike },
  machineId: string,
  command: HostCommand
): Promise<{ attempted: boolean }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-wake`;
  const res = await env.WS_DO_WORKER.fetch(`http://internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    throw new Error(`sendWakeToMachine: ws-do route returned ${res.status} for machine ${machineId}`);
  }

  return { attempted: parseAttemptedCountReceipt(await res.json()) > 0 };
}

/** Why `buildUnreadWakeCommand` decided NOT to wake — every reason is a permanent, current-state miss the consumer must `ack()`, never `retry()`. */
export type SkipReason =
  | "message_missing"
  | "invalid_message_scope"
  | "self_authored"
  | "bot_missing"
  | "bot_deleted"
  | "bot_unbound"
  | "forbidden"
  | "notice_channel_unresolvable"
  | "already_read"
  | "muted"
  | "mention_only";

export type BuildUnreadWakeResult =
  | {
      state: "ready";
      machineId: string;
      command: HostCommand;
    }
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
 *
 * When `env` is provided, also writes a `wake_trigger` audit row and asks
 * ws-do to fan the resulting `community:bot.audit_event` frame to the
 * owner's WS — both best-effort (wrapped in try/catch, MUST NOT block or
 * fail the wake). Callers that don't run in a Workers env (unit tests
 * exercising just the command-building) may omit `env`.
 */
export async function buildUnreadWakeCommand(
  db: Database,
  input: { messageId: string; botUserId: string },
  env?: WakeDispatchEnv
): Promise<BuildUnreadWakeResult> {
  const msg = await message.getWakeMessageScopeById(db, input.messageId);
  if (!msg) return { state: "skip", reason: "message_missing" };

  const scope = { channelId: msg.channelId };

  // Producer filtering already excludes self-wakes; the consumer must still
  // be robust to malformed/internal queue items that point a bot at its own
  // message.
  if (msg.authorId === input.botUserId) return { state: "skip", reason: "self_authored" };

  const botCtx = await bot.getBotWakeContext(db, input.botUserId);
  if (botCtx.state !== "ready") return { state: "skip", reason: botCtx.state };

  const canRead = await member.canBotReadWakeScope(db, input.botUserId, scope);
  if (!canRead) return { state: "skip", reason: "forbidden" };

  // Queue items are hints, not authority. Re-check current policy, persisted
  // attention, and the read cursor in one snapshot so a concurrent setting
  // mutation cannot clear this message between separate gates.
  const policyByUser = await notificationEligibility.resolveNotificationEligibilityForUsers(
    db,
    [input.botUserId],
    input.messageId,
  );
  const policy = policyByUser.get(input.botUserId);
  if (!policy) return { state: "skip", reason: "message_missing" };
  if (!policy.isReadable) return { state: "skip", reason: "forbidden" };
  if (!policy.isUnread) return { state: "skip", reason: "already_read" };
  const currentAllowed = policyAllows(policy.currentLevel, policy.hasAttention);
  if (!currentAllowed) {
    return {
      state: "skip",
      reason: policy.currentLevel === "nothing" ? "muted" : "mention_only",
    };
  }

  const channel = await agentInbox.resolveUnreadNoticeChannel(db, scope, input.botUserId);
  if (!channel) return { state: "skip", reason: "notice_channel_unresolvable" };

  const unreadNotice: UnreadNotice = {
    kind: "unread_notice",
    channel,
    latestSeq: msg.seq,
    channelId: scope.channelId,
  };
  const config = makeRuntimeConfig({
    runtime: botCtx.runtime,
    model: resolveModelConfig(botCtx.modelName),
    reasoningEffort: botCtx.reasoningEffort ?? undefined,
    runtimeConfigRevision: botCtx.runtimeConfigRevision,
    agentName: botCtx.name,
    agentHandle: `@${formatHandle(botCtx.name, botCtx.discriminator)}`,
  });

  const command: HostCommand = {
    type: "agent:wake",
    agentId: botCtx.botUserId,
    config,
    launchId: await unreadWakeLaunchId({
      botUserId: botCtx.botUserId,
      messageId: msg.id,
    }),
    unreadNotice,
  };

  // Audit trail (best-effort) — commit that this wake fired for a specific
  // trigger message. MUST NOT block or fail the wake: on retry (D1 blip) a
  // second row is preferable to a silently-lost wake. See "Audit write
  // failure policy" in plans/agent-unread-visibility-unify.md.
  try {
    await writeWakeTriggerAudit(db, env, {
      botUserId: input.botUserId,
      ownerUserId: botCtx.ownerUserId,
      launchId: command.launchId,
      messageId: msg.id,
      channel,
      seq: msg.seq,
      authorId: msg.authorId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("wake_trigger_audit_failed", {
      botUserId: input.botUserId,
      messageId: msg.id,
      err: String(err),
    });
  }

  return { state: "ready", machineId: botCtx.machineId, command };
}

async function writeWakeTriggerAudit(
  db: Database,
  env: WakeDispatchEnv | undefined,
  input: {
    botUserId: string;
    ownerUserId: string | null;
    launchId: string;
    messageId: string;
    channel: string;
    seq: number;
    authorId: string;
  }
): Promise<void> {
  // Owner is already known from `getBotWakeContext` — no second D1 hit.
  // Resolve sender handle in parallel with the mention check. Every lookup is
  // best-effort — a missing sender / D1 exception short-circuits the audit
  // write and MUST NOT surface as a wake failure. `allSettled` (not `all`) so
  // one rejected leg can't unhandled-reject the parallel legs before the
  // outer catch reaches them.
  if (!input.ownerUserId) return;
  const [senderRes, mentionRes] = await Promise.allSettled([
    getUsersByIds(db, [input.authorId]),
    mention.hasMentionForMessage(db, input.messageId, input.botUserId),
  ]);
  if (senderRes.status !== "fulfilled") return;
  const sender = senderRes.value[0];
  const isMention = mentionRes.status === "fulfilled" ? mentionRes.value : false;
  if (!sender) return;

  const payload = {
    messageId: input.messageId,
    channel: input.channel,
    seq: input.seq,
    senderId: input.authorId,
    senderHandle: `@${formatHandle(sender.name, sender.discriminator)}`,
    reason: (isMention ? "mention" : "unread") as "unread" | "mention",
  };
  // Fold the "handled today" heatmap bump into the SAME atomic batch as the
  // wake_trigger audit insert+prune — one message that triggers a wake = one
  // batched round-trip, not a separate hot-path write (Cecilia's perf red line,
  // #533). It shares the audit batch's all-or-nothing fate: a failed audit
  // write skips the +1 too, which is fine (a dropped increment on a D1 blip is
  // far cheaper than a per-message extra round-trip). `day` comes from the
  // shared `utcDayKey` so it agrees with the sent-side bump for the same
  // calendar day. This rollup is a calendar fact — never zeroed on nap/reset.
  const inserted = await botAuditLog.insertBotAuditWakeTrigger(
    db,
    { botId: input.botUserId, launchId: input.launchId, payload },
    [bot.bumpBotDailyActivityStatement(db, input.botUserId, utcDayKey(new Date()), "handled")]
  );
  if (!inserted || !env) return;

  // ws-do live broadcast — best-effort, must not block the wake. `catch`
  // swallows any transport failure; owner still sees the row on next UI
  // refresh via the D1 row that already landed above.
  try {
    await env.WS_DO_WORKER.fetch("http://internal/internal/broadcast-bot-audit-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: input.botUserId,
        ownerUserId: input.ownerUserId,
        id: inserted.id,
        kind: "wake_trigger",
        payload,
        createdAt: inserted.createdAt,
        launchId: input.launchId,
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("wake_trigger_broadcast_failed", {
      botUserId: input.botUserId,
      messageId: input.messageId,
      err: String(err),
    });
  }
}

/** Outcome of resolving ONE wake candidate — what every caller (the real queue consumer, and the dev-only inline stand-in) needs to decide what to log. */
export type DispatchOneWakeResult =
  | { outcome: "skip"; reason: SkipReason }
  | { outcome: "attempted" }
  | { outcome: "attempted_nowhere"; machineId: string };

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
  const result = await buildUnreadWakeCommand(db, input, env);
  if (result.state === "skip") return { outcome: "skip", reason: result.reason };
  const { attempted } = await sendWakeToMachine(env, result.machineId, result.command);
  return attempted ? { outcome: "attempted" } : { outcome: "attempted_nowhere", machineId: result.machineId };
}
