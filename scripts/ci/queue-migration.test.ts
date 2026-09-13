import { describe, expect, it } from "vitest"
import {
  QUEUE_MIGRATION_RESOURCES,
  buildQueueMigrationPlan,
} from "../cloudflare/queue-migration.mjs"

describe("queue resource migration plan", () => {
  it("is data-only, ordered, and never dual-writes", () => {
    const plan = buildQueueMigrationPlan()
    expect(plan.mode).toBe("plan-only")
    expect(plan.executesCommands).toBe(false)
    expect(plan.dualWrite).toBe(false)
    expect(plan.phases.map((phase) => phase.id)).toEqual([
      "prepare",
      "deploy-compatible-consumer",
      "producer-cutover",
      "drain-and-observe",
      "cleanup",
    ])
    expect(plan.phases.find((phase) => phase.id === "producer-cutover")?.gate)
      .toContain("exactly one producer binding")
  })

  it("keeps legacy deletion behind a separate post-drain authorization", () => {
    const plan = buildQueueMigrationPlan()
    const cleanup = plan.phases.at(-1)!
    expect(cleanup.id).toBe("cleanup")
    expect(cleanup.separatelyAuthorized).toBe(true)
    expect(cleanup.gate).toContain("STOP")
    expect(cleanup.commands.join("\n")).toContain(QUEUE_MIGRATION_RESOURCES.oldQueue)
    expect(cleanup.commands.join("\n")).toContain(QUEUE_MIGRATION_RESOURCES.oldDlq)
    expect(cleanup.commands.join("\n")).toContain(QUEUE_MIGRATION_RESOURCES.oldWorker)
  })
})
