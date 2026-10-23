import type { BotCreationSubmit } from "./community-bot-creation"

export type PlatformMachineRequest =
  | { action: "list" }
  | { action: "backends"; machineId: string }
  | { action: "models"; machineId: string; backendId: string; model?: string; refresh?: boolean; requestId?: string }

export type PlatformBotRequest = { action: "list" } | ({ action: "create" } & BotCreationSubmit)
