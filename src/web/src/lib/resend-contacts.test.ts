import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const logs = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock("@alook/shared", () => ({ createLogger: () => logs }))

import { syncResendSignupContact, unsubscribeResendContact } from "./resend-contacts"

const fetchMock = vi.fn<typeof fetch>()
const env = { RESEND_API_KEY: "mock-contact-key" } as Env
const user = { email: "qa@example.test", name: "QA Display Name" }
const segmentId = "6701946e-a7e2-442b-8fa5-aba379a81248"
const privateError = `${user.email} ${user.name} ${env.RESEND_API_KEY}`

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function existingContact(unsubscribed = false): Response {
  return response({ id: "contact-1", email: user.email, unsubscribed, object: "contact" })
}

function providerError(status: number, name = "application_error"): Response {
  return response({ name, message: privateError, statusCode: status }, status)
}

function requestAt(index: number) {
  const [url, options] = fetchMock.mock.calls[index]
  return {
    url,
    method: options?.method,
    body: typeof options?.body === "string" ? JSON.parse(options.body) : undefined,
  }
}

describe("Resend contact lifecycle with the official SDK", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    logs.warn.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("NODE_ENV", "development")
    vi.spyOn(console, "error")
  })
  afterEach(() => {
    expect(console.error).not.toHaveBeenCalled()
    for (const value of [user.email, user.name, env.RESEND_API_KEY]) {
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(value)
    }
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([undefined, ""])("skips all SDK network work without a Key (%s)", async (key) => {
    const noKey = { RESEND_API_KEY: key } as Env
    await syncResendSignupContact(noKey, user)
    await unsubscribeResendContact(noKey, user.email)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.warn).not.toHaveBeenCalled()
  })

  it("creates a definitely missing contact with the exact segment and no subscription reset", async () => {
    fetchMock.mockResolvedValueOnce(providerError(404, "not_found"))
      .mockResolvedValueOnce(response({ id: "new-contact", object: "contact" }))

    await expect(syncResendSignupContact(env, user)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestAt(0)).toEqual({
      url: `https://api.resend.com/contacts/${user.email}`, method: "GET", body: undefined,
    })
    expect(requestAt(1)).toEqual({
      url: "https://api.resend.com/contacts", method: "POST",
      body: { email: user.email, first_name: user.name, segments: [{ id: segmentId }] },
    })
    expect(logs.warn).not.toHaveBeenCalled()
  })

  it.each([false, true])("keeps existing subscription state (%s) while updating and joining New Signups", async (unsubscribed) => {
    fetchMock.mockResolvedValueOnce(existingContact(unsubscribed))
      .mockResolvedValueOnce(response({ id: "contact-1", object: "contact" }))
      .mockResolvedValueOnce(response({ id: segmentId }))

    await expect(syncResendSignupContact(env, user)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestAt(1)).toEqual({
      url: "https://api.resend.com/contacts/contact-1", method: "PATCH",
      body: { first_name: user.name },
    })
    expect(requestAt(2)).toEqual({
      url: `https://api.resend.com/contacts/contact-1/segments/${segmentId}`,
      method: "POST", body: undefined,
    })
    expect(logs.warn).not.toHaveBeenCalled()
  })

  it.each([[429, "rate_limit_exceeded"], [404, "validation_error"]])(
    "does not create after an uncertain lookup error (%i %s)", async (status, name) => {
      fetchMock.mockResolvedValueOnce(providerError(status, name))
      await syncResendSignupContact(env, user)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(logs.warn).toHaveBeenCalledWith("resend_contact_sync_failed", {
        action: "signup", stage: "lookup", errorCategory: "provider_error", statusCode: status,
      })
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(privateError)
    },
  )

  it.each(["create", "update", "segment"] as const)("contains a %s response error and stops dependent calls", async (stage) => {
    fetchMock.mockResolvedValueOnce(stage === "create" ? providerError(404, "not_found") : existingContact(true))
    if (stage === "segment") fetchMock.mockResolvedValueOnce(response({ id: "contact-1" }))
    fetchMock.mockResolvedValueOnce(providerError(500))

    await expect(syncResendSignupContact(env, user)).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(stage === "segment" ? 3 : 2)
    expect(logs.warn).toHaveBeenCalledWith("resend_contact_sync_failed", {
      action: "signup", stage, errorCategory: "provider_error", statusCode: 500,
    })
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(privateError)
  })

  it("contains a rejected SDK request without logging its raw error", async () => {
    fetchMock.mockRejectedValueOnce(new Error(privateError))
    await expect(syncResendSignupContact(env, user)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(logs.warn).toHaveBeenCalledWith("resend_contact_sync_failed", {
      action: "signup", stage: "lookup", errorCategory: "provider_error",
    })
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(privateError)
  })

  it("retains the deleted account's contact with a global unsubscribe only", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "contact-1", object: "contact" }))
    await expect(unsubscribeResendContact(env, user.email)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requestAt(0)).toEqual({
      url: `https://api.resend.com/contacts/${user.email}`, method: "PATCH",
      body: { unsubscribed: true },
    })
    expect(logs.warn).not.toHaveBeenCalled()
  })

  it.each([404, 429, 500])("contains an unsubscribe response failure (%i) without creating/removing a contact", async (status) => {
    fetchMock.mockResolvedValueOnce(providerError(status, status === 404 ? "not_found" : "application_error"))
    await expect(unsubscribeResendContact(env, user.email)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(logs.warn).toHaveBeenCalledWith("resend_contact_sync_failed", {
      action: "account-deletion", stage: "update", errorCategory: "provider_error", statusCode: status,
    })
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(privateError)
  })

  it("contains a malformed successful SDK response as a sanitized exception", async () => {
    fetchMock.mockResolvedValueOnce(response(null))
    await expect(syncResendSignupContact(env, user)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(logs.warn).toHaveBeenCalledWith("resend_contact_sync_failed", {
      action: "signup", stage: "update", errorCategory: "exception",
    })
  })

  it("contains SDK constructor exceptions in both operations without raw console logs", async () => {
    const invalidEnv = { RESEND_API_KEY: "mock\ninvalid" } as Env
    await expect(syncResendSignupContact(invalidEnv, user)).resolves.toBeUndefined()
    await expect(unsubscribeResendContact(invalidEnv, user.email)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.warn.mock.calls).toEqual([
      ["resend_contact_sync_failed", { action: "signup", stage: "lookup", errorCategory: "exception" }],
      ["resend_contact_sync_failed", { action: "account-deletion", stage: "update", errorCategory: "exception" }],
    ])
  })
})
