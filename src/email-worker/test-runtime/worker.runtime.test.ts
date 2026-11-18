/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import type { ImapPollerDO } from "../src/imap-poller-do"

const runtimeEnv = env as unknown as { IMAP_POLLER: DurableObjectNamespace }
const worker = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default

describe("OTP worker production entrypoint", () => {
  it("serves health and rejects retired mail routes", async () => {
    const response = await worker.fetch(new Request("https://worker.test/health"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
    for (const path of ["/send/agent", "/imap/start?accountId=old", "/imap/sync?accountId=old"]) {
      expect((await worker.fetch(new Request(`https://worker.test${path}`, { method: "POST" }))).status).toBe(404)
    }
    expect((await worker.fetch(new Request("https://worker.test/unknown"))).status).toBe(405)
  })

  it("keeps deployed IMAP objects inert without deleting their retained storage", async () => {
    const stub = runtimeEnv.IMAP_POLLER.get(runtimeEnv.IMAP_POLLER.idFromName(crypto.randomUUID()))
    expect((await stub.fetch(new Request("https://imap.test/start", { method: "POST" }))).status).toBe(410)
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("accountId", "retired-account")
      await (instance as ImapPollerDO).alarm()
      expect(await state.storage.getAlarm()).toBeNull()
      expect(await state.storage.get("accountId")).toBe("retired-account")
    })
  })
})
