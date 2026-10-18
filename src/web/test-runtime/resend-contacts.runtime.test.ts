/// <reference types="@cloudflare/vitest-plugin/types" />

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { syncResendSignupContact, unsubscribeResendContact } from "../src/lib/resend-contacts"

const env = { RESEND_API_KEY: "mock-runtime-key" } as Env
const user = { email: "contact-runtime@example.test", name: "Runtime QA" }
const segmentId = "6701946e-a7e2-442b-8fa5-aba379a81248"

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("official Resend SDK in workerd", () => {
  it.each(["production", "development", "test", undefined])(
    "preserves sanitized waitUntil warnings and SDK logging in NODE_ENV=%s", async (mode) => {
      vi.stubEnv("NODE_ENV", mode)
      expect(process.env.NODE_ENV).toBe(mode)
      const privateError = `${user.email} ${user.name} ${env.RESEND_API_KEY}`
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
        name: "application_error", statusCode: 500, message: privateError,
      }, { status: 500 }))
      vi.stubGlobal("fetch", fetchMock)
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      const context = createExecutionContext()
      context.waitUntil(syncResendSignupContact(env, user))
      context.waitUntil(unsubscribeResendContact(env, user.email))

      await expect(waitOnExecutionContext(context)).resolves.toBeUndefined()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledTimes(2)
      const entries = log.mock.calls.map(([value]) => JSON.parse(value as string))
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          service: "resend-contacts", msg: "resend_contact_sync_failed", action: "signup",
          stage: "lookup", errorCategory: "provider_error", statusCode: 500,
        }),
        expect.objectContaining({
          service: "resend-contacts", msg: "resend_contact_sync_failed", action: "account-deletion",
          stage: "update", errorCategory: "provider_error", statusCode: 500,
        }),
      ]))
      for (const value of [user.email, user.name, env.RESEND_API_KEY]) {
        expect(JSON.stringify(log.mock.calls)).not.toContain(value)
      }
      if (mode === "production") {
        expect(error).not.toHaveBeenCalled()
      } else {
        expect(error).toHaveBeenCalledTimes(2)
        expect(error).toHaveBeenCalledWith("[Resend API Error]:", expect.objectContaining({
          status: 500, error: expect.objectContaining({ message: privateError }),
        }))
      }
    },
  )

  it("creates a contact and sends its signup event within the original execution context", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: "not_found", statusCode: 404, message: "Missing contact" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ id: "runtime-contact", object: "contact" }))
      .mockResolvedValueOnce(Response.json({ object: "event", event: "new_signup" }))
    vi.stubGlobal("fetch", fetchMock)
    const context = createExecutionContext()
    context.waitUntil(syncResendSignupContact(env, user))
    const response = new Response("created")
    expect(await response.text()).toBe("created")
    await waitOnExecutionContext(context)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.resend.com/contacts")
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      email: user.email, first_name: user.name, segments: [{ id: segmentId }],
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.resend.com/events/send")
    expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({
      event: "new_signup", contact_id: "runtime-contact",
    })
  })

  it("contains a failed signup event within waitUntil without retrying or logging private data", async () => {
    const privateError = `${user.email} ${user.name} ${env.RESEND_API_KEY}`
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "runtime-contact", unsubscribed: false }))
      .mockResolvedValueOnce(Response.json({ id: "runtime-contact" }))
      .mockResolvedValueOnce(Response.json({ id: segmentId }))
      .mockResolvedValueOnce(Response.json({ name: "application_error", statusCode: 500, message: privateError }, { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    const log = vi.spyOn(console, "log")
    const error = vi.spyOn(console, "error")
    const context = createExecutionContext()
    context.waitUntil(syncResendSignupContact(env, user))
    await expect(waitOnExecutionContext(context)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3]?.[0]).toBe("https://api.resend.com/events/send")
    expect(error).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      service: "resend-contacts", msg: "resend_contact_sync_failed", action: "signup",
      stage: "event", errorCategory: "provider_error", statusCode: 500,
    })
    for (const value of [user.email, user.name, env.RESEND_API_KEY]) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(value)
    }
  })

  it("contains unsubscribe provider failure without leaking its body or email through console", async () => {
    const privateError = `${user.email} ${user.name} ${env.RESEND_API_KEY}`
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      name: "rate_limit_exceeded", statusCode: 429, message: privateError,
    }, { status: 429 }))
    vi.stubGlobal("fetch", fetchMock)
    const log = vi.spyOn(console, "log")
    const error = vi.spyOn(console, "error")
    const context = createExecutionContext()
    context.waitUntil(unsubscribeResendContact(env, user.email))
    await expect(waitOnExecutionContext(context)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH")
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ unsubscribed: true })
    expect(error).not.toHaveBeenCalled()
    const entry = JSON.parse(log.mock.calls[0]?.[0] as string)
    expect(entry).toMatchObject({
      service: "resend-contacts", msg: "resend_contact_sync_failed", action: "account-deletion",
      stage: "update", errorCategory: "provider_error", statusCode: 429,
    })
    for (const value of [user.email, user.name, env.RESEND_API_KEY]) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(value)
    }
  })

  it("skips both operations with the optional binding absent", async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetchMock)
    const context = createExecutionContext()
    context.waitUntil(syncResendSignupContact({} as Env, user))
    context.waitUntil(unsubscribeResendContact({} as Env, user.email))
    await waitOnExecutionContext(context)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
