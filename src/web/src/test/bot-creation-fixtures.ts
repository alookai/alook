import type { BotCreationPayload } from "@alook/shared"

export function botCreationFixture(overrides: Partial<BotCreationPayload> = {}): BotCreationPayload {
  return {
    requestId: "request-1", status: "pending", requesterId: "requester", ownerUserId: "viewer",
    createdAt: "2026-10-22T09:00:00Z", resolvedAt: null,
    bots: [{
      itemId: "item-1", name: "Researcher", machineId: "machine-1", backendId: "codex",
      model: "model-a", reasoningEffort: "high", reason: "Check sources independently",
      description: "Find sources and report uncertainty", machineName: "Work Mac", createdBot: null,
    }],
    ...overrides,
  }
}
