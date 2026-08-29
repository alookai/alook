import { createLogger } from "@alook/shared"
import type {
  BotAddedFrame,
  BotUpdatedFrame,
  BotRemovedFrame,
  RuntimeConfig,
} from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"

const log = createLogger({ service: "community-bot-push" })

type BotEventFrame = BotAddedFrame | BotUpdatedFrame | BotRemovedFrame

export type MachineUpdatePushResult =
  | { sent: number; deliveryError: false }
  | { sent: 0; deliveryError: true }

export async function pushMachineUpdate(
  env: Env,
  machineId: string,
): Promise<MachineUpdatePushResult> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-update`
  try {
    const response = await wsDoFetch(
      env,
      path,
      { method: "POST" },
      { label: machineId, type: "machine:update" },
    )
    if (!response.ok) {
      log.warn("machine:update push non-ok", { machineId, status: response.status })
      return { sent: 0, deliveryError: true }
    }
    const data = await response.json() as { sent?: unknown }
    if (
      typeof data.sent !== "number"
      || !Number.isSafeInteger(data.sent)
      || data.sent < 0
    ) {
      log.warn("machine:update push malformed", { machineId })
      return { sent: 0, deliveryError: true }
    }
    return { sent: data.sent, deliveryError: false }
  } catch (err) {
    log.warn("machine:update push threw", { machineId, err: String(err) })
    return { sent: 0, deliveryError: true }
  }
}

/**
 * Push a bot event (bot:added / bot:updated / bot:removed) to the machine's
 * daemon connection via the WS Durable Object.
 *
 * The event is a HostCommand-shape frame (colon-namespaced), delivered on
 * the same WS pipe the daemon uses for agent:* frames.
 *
 * The WS DO is keyed by credential `do_name` (first 32 hex chars of the
 * credential hash); this helper does the credential lookup at the DO layer.
 * If the daemon is offline, the DO drops the event — the daemon's cold-start
 * warmup will re-fetch authoritative state on next reconnect.
 */
export async function pushBotEventToMachine(
  env: Env,
  machineId: string,
  event: BotEventFrame,
): Promise<void> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/push`
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
      { label: machineId, type: event.type },
    )
    if (!res.ok) {
      log.warn("bot event push non-ok", {
        machineId,
        type: event.type,
        status: res.status,
      })
    }
  } catch (err) {
    log.warn("bot event push threw", {
      machineId,
      type: event.type,
      err: String(err),
    })
  }
}

/**
 * Push an owner-triggered `agent:reset` to the machine's daemon over WS.
 *
 * Narrowly typed (only reset fields, no arbitrary HostCommand) so no caller
 * can smuggle a different command shape onto the wire. Returns the ws-do
 * response's `{ sent }` count — `sent === 0` means the daemon is not
 * currently connected; the caller is expected to translate that into a 409.
 */
export async function pushAgentResetToMachine(
  env: Env,
  machineId: string,
  args: { agentId: string; config: RuntimeConfig; launchId: string },
): Promise<{ sent: number }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-reset`
  const body = JSON.stringify({
    agentId: args.agentId,
    config: args.config,
    launchId: args.launchId,
  })
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { label: machineId, type: "agent:reset" },
    )
    if (!res.ok) {
      log.warn("agent:reset push non-ok", {
        machineId,
        status: res.status,
      })
      return { sent: 0 }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0 }
  } catch (err) {
    log.warn("agent:reset push threw", {
      machineId,
      err: String(err),
    })
    return { sent: 0 }
  }
}

/**
 * Push an owner-triggered BATCH reset (`machine:reset_all`) to a machine's
 * daemon over WS — one frame carrying every agent's reset payload, NOT N
 * fanned-out `agent:reset` calls.
 *
 * Narrowly typed (only the reset array) so no caller can smuggle another
 * command shape. Returns `{ sent }` — `sent === 0` means the daemon isn't
 * connected; the caller translates that into a 409.
 */
export async function pushBatchResetToMachine(
  env: Env,
  machineId: string,
  resets: Array<{ agentId: string; config: RuntimeConfig; launchId: string }>,
): Promise<{ sent: number }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-batch-reset`
  const body = JSON.stringify({
    resets: resets.map((r) => ({
      agentId: r.agentId,
      config: r.config,
      launchId: r.launchId,
    })),
  })
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { label: machineId, type: "machine:reset_all" },
    )
    if (!res.ok) {
      log.warn("machine:reset_all push non-ok", {
        machineId,
        status: res.status,
      })
      return { sent: 0 }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0 }
  } catch (err) {
    log.warn("machine:reset_all push threw", {
      machineId,
      err: String(err),
    })
    return { sent: 0 }
  }
}

/**
 * Push an agent-self-initiated `agent:nap` to the bot's OWN machine over WS.
 *
 * Twin of `pushAgentResetToMachine` — same narrow allowlist plus the mandatory
 * `handoff` string (the agent's note to its reborn self, spliced into the nap
 * rewake prompt daemon-side). Returns `{ sent }`; `sent === 0` means the daemon
 * isn't connected and the caller translates it into a 409 (and writes NO audit
 * row — the audit signals a real nap landed, not a request).
 */
export async function pushAgentNapToMachine(
  env: Env,
  machineId: string,
  args: { agentId: string; config: RuntimeConfig; launchId: string; handoff: string },
): Promise<{ sent: number }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-nap`
  const body = JSON.stringify({
    agentId: args.agentId,
    config: args.config,
    launchId: args.launchId,
    handoff: args.handoff,
  })
  try {
    const res = await wsDoFetch(
      env,
      path,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      { label: machineId, type: "agent:nap" },
    )
    if (!res.ok) {
      log.warn("agent:nap push non-ok", { machineId, status: res.status })
      return { sent: 0 }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0 }
  } catch (err) {
    log.warn("agent:nap push threw", { machineId, err: String(err) })
    return { sent: 0 }
  }
}

/**
 * Push an owner-triggered `agent:model_switch` to the machine's daemon over WS.
 *
 * Narrowly typed (only switch fields, no arbitrary HostCommand) so no caller
 * can smuggle a different command shape onto the wire. Unlike
 * `pushAgentResetToMachine`, this DISTINGUISHES a transport failure from "no
 * daemon connected": a non-ok response or a thrown fetch returns
 * `deliveryError: true`, while a 200 with `sent: 0` (daemon just offline)
 * returns `deliveryError: false`. The route maps those to 503 and 409;
 * completion audit is written later when the switched launch reports its
 * `agent_session`.
 */
export async function pushAgentModelSwitchToMachine(
  env: Env,
  machineId: string,
  args: {
    agentId: string
    config: RuntimeConfig
    launchId: string
    from: string | null
    to: string | null
  },
): Promise<{ sent: number; deliveryError: boolean }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-model-switch`
  const body = JSON.stringify({
    agentId: args.agentId,
    config: args.config,
    launchId: args.launchId,
    from: args.from,
    to: args.to,
  })
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { label: machineId, type: "agent:model_switch" },
    )
    if (!res.ok) {
      log.warn("agent:model_switch push non-ok", {
        machineId,
        status: res.status,
      })
      return { sent: 0, deliveryError: true }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0, deliveryError: false }
  } catch (err) {
    log.warn("agent:model_switch push threw", {
      machineId,
      err: String(err),
    })
    return { sent: 0, deliveryError: true }
  }
}

export async function pushAgentRuntimeConfigUpdateToMachine(
  env: Env,
  machineId: string,
  args: { agentId: string; config: RuntimeConfig },
): Promise<{ sent: number; deliveryError: boolean }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-runtime-config-update`
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      },
      { label: machineId, type: "agent:runtime_config_update" },
    )
    if (!res.ok) return { sent: 0, deliveryError: true }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0, deliveryError: false }
  } catch (err) {
    log.warn("agent:runtime_config_update push threw", { machineId, err: String(err) })
    return { sent: 0, deliveryError: true }
  }
}

export async function pushAgentProviderSwitchToMachine(
  env: Env,
  machineId: string,
  args: {
    agentId: string
    config: RuntimeConfig
    launchId: string
    from: string
    to: string
  },
): Promise<{ sent: number; deliveryError: boolean }> {
  const path = `/community-machine/by-id/${encodeURIComponent(machineId)}/forward-agent-provider-switch`
  const body = JSON.stringify(args)
  try {
    const res = await wsDoFetch(
      env,
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { label: machineId, type: "agent:provider_switch" },
    )
    if (!res.ok) {
      log.warn("agent:provider_switch push non-ok", { machineId, status: res.status })
      return { sent: 0, deliveryError: true }
    }
    const data = (await res.json()) as { sent?: number }
    return { sent: data.sent ?? 0, deliveryError: false }
  } catch (err) {
    log.warn("agent:provider_switch push threw", { machineId, err: String(err) })
    return { sent: 0, deliveryError: true }
  }
}
