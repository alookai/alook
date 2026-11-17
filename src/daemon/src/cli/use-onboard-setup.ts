import { readFile, stat } from "node:fs/promises"
import type { Command } from "commander"
import { AutomationSetupInputSchema, AutomationSetupResultSchema, MAX_MESSAGE_CONTENT_LENGTH } from "@alook/shared"

type AutomationRequest = (path: string, body?: unknown, timeoutMs?: number) => Promise<{ result: Record<string, unknown>; origin: string }>
type SetupOptions = { server: string; description?: string; bot: string[]; taskFile: string }

export function registerOnboardSetup(use: Command, request: AutomationRequest, output: (value: { success: unknown }) => void) {
  use.command("onboard-setup").description("create a server, join selected owned bots and send its first task")
    .requiredOption("--server <name>", "new server name")
    .option("--description <text>", "server description")
    .requiredOption("--bot <id>", "existing owned bot ID; repeat for up to three bots", (value: string, previous: string[]) => [...previous, value], [])
    .requiredOption("--task-file <path>", "UTF-8 first task")
    .action(async (options: SetupOptions) => {
      const taskInfo = await stat(options.taskFile)
      if (!taskInfo.isFile() || taskInfo.size > (MAX_MESSAGE_CONTENT_LENGTH - 512) * 4) throw new Error("Task file is invalid or too large")
      const bytes = await readFile(options.taskFile)
      if (bytes.length > (MAX_MESSAGE_CONTENT_LENGTH - 512) * 4) throw new Error("Task file is too large")
      const firstTask = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).trim()
      const input = AutomationSetupInputSchema.parse({ server: { name: options.server, ...(options.description ? { description: options.description } : {}) }, botIds: options.bot, firstTask })
      try {
        const { result } = await request("/api/community/automation/onboard-setup", input)
        output({ success: AutomationSetupResultSchema.parse(result) })
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { hint: [(error as Error & { hint?: string }).hint, "If the command response was not received, check the server and its bot membership in Alook before running setup again. Do not expire the access code until the user confirms satisfaction."].filter(Boolean).join(" ") })
        throw error
      }
    })
}
