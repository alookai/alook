import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8")
}

describe("committed-message delivery architecture", () => {
  it("keeps the message handler as a persistence-to-dispatch seam", () => {
    const handler = source("./message-handler.ts")
    expect(handler).toContain("dispatchCommittedMessage(db, row.id")
    expect(handler).not.toMatch(
      /dispatchMessageNotify|resolveChannelRecipients|wakeMessageRow|enqueueBotWakes/,
    )
    expect(handler).not.toMatch(/type:\s*WS_EVENTS\.MESSAGE_CREATE/)
  })

  it("removes message wake policy from generic fanout", () => {
    const fanout = source("./fanout.ts")
    expect(fanout).not.toMatch(/wake-producer|wakeMessageRow|excludeWakeUserId|maybeEnqueueWakes/)
  })

  it("leaves wake-producer as payload transport rather than a second planner", () => {
    const producer = source("./wake-producer.ts")
    expect(producer).toContain("enqueueBotWakePayloads")
    expect(producer).not.toMatch(/\bqueries\b|findWakeCandidates|resolveNotificationEligibility/)
  })

  it("deletes the old per-recipient notify implementation", () => {
    expect(existsSync(new URL("./notify.ts", import.meta.url))).toBe(false)
    expect(existsSync(new URL("./notify.test.ts", import.meta.url))).toBe(false)
  })
})
