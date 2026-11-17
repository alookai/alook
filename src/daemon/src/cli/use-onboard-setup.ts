import { readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import type { Command } from "commander"
import { z } from "zod"
import { AutomationSetupInputSchema, AutomationSetupNewBotSchema, AutomationSetupResultSchema, MAX_MESSAGE_CONTENT_LENGTH } from "@alook/shared"

type AutomationRequest = (path: string, body?: unknown, timeoutMs?: number) => Promise<{ result: Record<string, unknown>; origin: string }>
type SetupOptions = { server: string; description?: string; machine?: string; bot: string[]; taskFile: string }
const Machines = z.array(z.object({ id: z.string(), name: z.string().nullable().optional(), status: z.string(),
  backends: z.array(z.object({ id: z.string(), health: z.string(), modelRequired: z.boolean() })),
}))
const DraftBot = AutomationSetupNewBotSchema.omit({ machineId: true, backendId: true }).extend({ machineId: z.string().min(1).optional(), backendId: z.string().min(1).optional() })
const ReusedBot = z.strictObject({ existingBotId: z.string().min(1).max(128) })

async function ask(question: string, code: string): Promise<string> {
  if (!process.stdin.isTTY) throw Object.assign(new Error(question), { code, hint: "Confirm the choice with the user, then provide it in --bot JSON and run the command again" })
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try { return (await prompt.question(`${question}\n> `)).trim() } finally { prompt.close() }
}

async function choose(question: string, choices: string[], code: string): Promise<string> {
  if (!choices.length) throw Object.assign(new Error(`No available choice for ${question}`), { code })
  const answer = await ask(`${question}\n${choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n")}`, code)
  const index = Number(answer) - 1
  const result = Number.isInteger(index) ? choices[index] : choices.find(choice => choice === answer)
  if (!result) throw Object.assign(new Error("Choose one of the reported options before setup"), { code })
  return result
}

function parseBot(value: string) {
  let raw: unknown
  if (value.trimStart().startsWith("{")) {
    try { raw = JSON.parse(value) } catch { throw new Error("Invalid --bot JSON") }
  } else {
    const separator = value.indexOf(":")
    raw = separator < 0 ? { name: value } : { name: value.slice(0, separator), backendId: value.slice(separator + 1) }
  }
  const parsed = z.union([DraftBot, ReusedBot]).safeParse(raw)
  if (!parsed.success) throw new Error("Use --bot Name:backend or bot JSON with name and optional machineId/backendId/model/reasoningEffort, or existingBotId")
  return parsed.data
}

export function registerOnboardSetup(use: Command, request: AutomationRequest, output: (value: { success: unknown }) => void) {
  use.command("onboard-setup").description("create a team, join owned bots and send its first task without waiting for replies")
    .requiredOption("--server <name>", "new server name")
    .option("--description <text>", "server description")
    .option("--machine <id>", "default machine for new bots")
    .requiredOption("--bot <name:backend|json>", "repeat for up to three bots; omit backend to choose interactively", (value: string, previous: string[]) => [...previous, value], [])
    .requiredOption("--task-file <path>", "UTF-8 first task")
    .action(async (options: SetupOptions) => {
      if (options.bot.length < 1 || options.bot.length > 3) throw new Error("Choose one to three bots")
      const taskInfo = await stat(options.taskFile)
      if (!taskInfo.isFile() || taskInfo.size > (MAX_MESSAGE_CONTENT_LENGTH - 512) * 4) throw new Error("Task file is invalid or too large")
      const bytes = await readFile(options.taskFile)
      if (bytes.length > (MAX_MESSAGE_CONTENT_LENGTH - 512) * 4) throw new Error("Task file is too large")
      const firstTask = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).trim()
      const draft = options.bot.map(parseBot)
      const { result: preflight } = await request("/api/community/automation/onboard-setup")
      const machines = Machines.parse(preflight.machines).filter(machine => machine.status === "online")
      const bots = []
      for (const bot of draft) {
        if ("existingBotId" in bot) { bots.push(bot); continue }
        const machineId = bot.machineId ?? options.machine ?? (machines.length === 1 ? machines[0]!.id : await choose(`Choose a machine for ${bot.name}`, machines.map(machine => machine.id), "MACHINE_SELECTION_REQUIRED"))
        const machine = machines.find(value => value.id === machineId)
        if (!machine) throw Object.assign(new Error(`Machine ${machineId} is not online or owned`), { code: "MACHINE_UNAVAILABLE" })
        const available = machine.backends.filter(backend => backend.health === "healthy")
        const backendId = bot.backendId ?? await choose(`Which backend should ${bot.name} use?`, available.map(backend => backend.id), "BACKEND_SELECTION_REQUIRED")
        const backend = available.find(value => value.id === backendId)
        if (!backend) throw Object.assign(new Error(`Backend ${backendId} is unavailable on ${machineId}`), { code: "BACKEND_UNAVAILABLE" })
        const model = backend.modelRequired && !bot.model ? await ask(`Enter the chosen model ID for ${bot.name} (${backendId})`, "MODEL_REQUIRED") : bot.model
        bots.push(AutomationSetupNewBotSchema.parse({ ...bot, machineId, backendId, model }))
      }
      const payload = { server: { name: options.server, ...(options.description ? { description: options.description } : {}) }, bots, firstTask }
      const input = AutomationSetupInputSchema.parse(payload)
      try {
        const { result } = await request("/api/community/automation/onboard-setup", input)
        output({ success: AutomationSetupResultSchema.parse(result) })
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { hint: [(error as Error & { hint?: string }).hint, "If the command response was not received, check the server and bots with use server --list and use bot --list before running setup again. Do not expire the access code until the user confirms satisfaction."].filter(Boolean).join(" ") })
        throw error
      }
    })
}
