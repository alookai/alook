import type { Command } from "commander"
import { randomUUID } from "node:crypto"
import { BotCreationSubmitSchema, BOT_CREATION_BODY_MAX_BYTES } from "@alook/shared"
import type { ServerApi } from "../server/contract.js"

const failure = (message: string, code: string, details?: Record<string, unknown>) => Object.assign(new Error(message), { code, platformDetails: details })

export function registerPlatformCommands(program: Command, getApi: () => ServerApi, output: (value: { success: unknown }) => void) {
  const platform = program.command("platform").description("owner-scoped platform capabilities").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  const machine = platform.command("machine").description("read machines, backends, models and model-specific effort").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--list", "list your owner's machines")
    .option("--backends", "show backends on --id")
    .option("--models", "show models and effort for --id and --backend")
    .option("--id <id>", "owner machine ID")
    .option("--backend <id>", "backend ID from the selected machine")
    .option("--model <id>", "show effort for this full model ID")
    .option("--refresh", "ask the target to refresh its reported models")
  machine.action(async () => {
    const opts = machine.opts()
    const actions = [opts.list, opts.backends, opts.models].filter(Boolean).length
    if (!actions && Object.keys(opts).length === 0) { output({ success: { usage: machine.helpInformation() } }); return }
    if (actions !== 1) throw failure("Choose one action: --list, --backends, or --models", "INVALID_ACTION")
    if (opts.list && (opts.id || opts.backend || opts.model || opts.refresh)) throw failure("--list does not accept target or model flags", "INVALID_ACTION")
    if (!opts.list && !opts.id) throw failure("--id is required", "MACHINE_REQUIRED")
    if (opts.backends && (opts.backend || opts.model || opts.refresh)) throw failure("--backends only accepts --id", "INVALID_ACTION")
    if (opts.models && !opts.backend) throw failure("--models requires --backend", "BACKEND_REQUIRED")
    const api = getApi()
    if (!api.platformMachine) throw failure("Platform machine commands are unavailable", "UPGRADE_REQUIRED")
    const result = await api.platformMachine(opts.list ? { action: "list" } : opts.backends ? { action: "backends", machineId: opts.id }
        : { action: "models", machineId: opts.id, backendId: opts.backend, ...(opts.model ? { model: opts.model } : {}), refresh: opts.refresh === true, ...(opts.refresh ? { requestId: randomUUID() } : {}) })
    output({ success: result })
  })
  const bot = platform.command("bot").description("read bots or request owner-approved creation").exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--list", "list your owner's bot summaries")
    .option("--create <bot-json>", "request one bot; repeat for one gallery request", (value: string, previous: string[]) => [...previous, value], [])
  bot.action(async () => {
    const opts = bot.opts()
    const values: string[] = opts.create
    const actions = [opts.list, values.length > 0].filter(Boolean).length
    if (!actions) { output({ success: { usage: bot.helpInformation() } }); return }
    if (actions !== 1) throw failure("Choose one action: --list or one or more --create values", "INVALID_ACTION")
    const api = getApi()
    if (!api.platformBot) throw failure("Platform bot commands are unavailable", "UPGRADE_REQUIRED")
    if (opts.list) { output({ success: await api.platformBot({ action: "list" }) }); return }
    if (Buffer.byteLength(values.join(""), "utf8") > BOT_CREATION_BODY_MAX_BYTES) throw failure("Creation request is too large", "REQUEST_TOO_LARGE")
    const bots = values.map((value, index) => {
      try { return JSON.parse(value) as unknown } catch { throw failure("Invalid bot JSON", "INVALID_PROPOSAL", { itemIndex: index + 1 }) }
    })
    const parsed = BotCreationSubmitSchema.safeParse({ requestId: randomUUID(), bots })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!
      const field = issue.path.at(-1)
      const itemIndex = typeof issue.path[1] === "number" ? issue.path[1] + 1 : undefined
      throw failure(issue.message, field === "reason" && issue.code === "too_small" ? "REASON_REQUIRED" : "INVALID_PROPOSAL", { ...(itemIndex ? { itemIndex } : {}), field })
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > BOT_CREATION_BODY_MAX_BYTES) throw failure("Creation request is too large", "REQUEST_TOO_LARGE")
    output({ success: await api.platformBot({ action: "create", ...parsed.data }) })
  })
}
