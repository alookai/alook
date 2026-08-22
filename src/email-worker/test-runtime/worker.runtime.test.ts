/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  IMAP_POLLER: DurableObjectNamespace
}

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

describe("email-worker workerd runtime", () => {
  it("loads production migrations and serves the production entrypoint", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("agent_email_account").first<{ name: string }>()
    expect(schema?.name).toBe("agent_email_account")

    const response = await worker.fetch(new Request("https://worker.test/health"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("reads and writes through the real email R2 binding", async () => {
    const key = `runtime/${crypto.randomUUID()}`
    await runtimeEnv.EMAIL_BUCKET.put(key, "runtime email")

    const stored = await runtimeEnv.EMAIL_BUCKET.get(key)
    expect(stored).not.toBeNull()
    await expect(stored!.text()).resolves.toBe("runtime email")

    await runtimeEnv.EMAIL_BUCKET.delete(key)
    await expect(runtimeEnv.EMAIL_BUCKET.get(key)).resolves.toBeNull()
  })

  it("persists and clears state through the real IMAP Durable Object", async () => {
    const accountId = `runtime-${crypto.randomUUID()}`
    const start = await worker.fetch(new Request(
      `https://worker.test/imap/start?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST" },
    ))
    expect(start.status).toBe(200)

    const id = runtimeEnv.IMAP_POLLER.idFromName(accountId)
    const stub = runtimeEnv.IMAP_POLLER.get(id)
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.get("accountId")).resolves.toBe(accountId)
      await expect(state.storage.getAlarm()).resolves.not.toBeNull()
    })

    const stop = await worker.fetch(new Request(
      `https://worker.test/imap/stop?accountId=${encodeURIComponent(accountId)}`,
      { method: "POST" },
    ))
    expect(stop.status).toBe(200)

    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.get("accountId")).resolves.toBeUndefined()
      await expect(state.storage.getAlarm()).resolves.toBeNull()
    })
  })
})
