import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { ONBOARDING_ANALYTICS_STAGES, PRODUCT_ANALYTICS_EVENTS } from "./product-analytics-contract"
import { authFailureParams } from "./auth-failure"

function documentSender(origin = "https://alook.ai") {
  const html = readFileSync(new URL("../../public/analytics-events.html", import.meta.url), "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error("missing event document script")
  const window = { gtag: undefined as ((...args: unknown[]) => void) | undefined, dataLayer: [] as ArrayLike<unknown>[], sendProductEvent: (_input: { event: string; params: Record<string, string> }) => {} }
  const scripts: { src?: string; async?: boolean }[] = []
  const document = { createElement: () => ({}), head: { appendChild: (script: { src?: string; async?: boolean }) => scripts.push(script) } }
  runInNewContext(script, { window, document, location: { origin } })
  window.dataLayer.length = 0
  return { ...window, scripts }
}

describe("actual isolated product-event document", () => {
  it("accepts exactly the finite names while keeping fixed private-page metadata", () => {
    const document = documentSender()
    for (const event of PRODUCT_ANALYTICS_EVENTS) document.sendProductEvent({ event, params: { private_id: "secret", page_location: "https://private.test/token", method: "private", failure_stage: "private", stage: "harness" } })
    document.sendProductEvent({ event: "unknown", params: {} })
    const commands = document.dataLayer.map(command => Array.from(command))
    expect(commands).toHaveLength(PRODUCT_ANALYTICS_EVENTS.length)
    expect(commands.map(command => command[1])).toEqual([...PRODUCT_ANALYTICS_EVENTS])
    for (const command of commands) expect(command[2]).toEqual({ page_location: "https://alook.ai/analytics/product", page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY", ...(["community_onboarding_stage_completed", "community_onboarding_skipped"].includes(String(command[1])) ? { stage: "harness" } : {}) })
    expect(JSON.stringify(commands)).not.toContain("secret")
  })
})

it("retains the existing allowed authentication dimensions in the actual event document", () => {
  const document = documentSender()
  document.sendProductEvent({ event: "sign_up", params: { method: "email" } })
  document.sendProductEvent({ event: "sign_in_failed", params: { method: "github", failure_stage: "social_start" } })
  document.sendProductEvent({ event: "landing_cta_clicked", params: { cta_name: "get_started" } })
  expect(Array.from(document.dataLayer[0])[2]).toMatchObject({ method: "email" })
  expect(Array.from(document.dataLayer[1])[2]).toMatchObject({ method: "github", failure_stage: "social_start" })
  expect(Array.from(document.dataLayer[2])[2]).toMatchObject({ cta_name: "get_started" })
})

it.each([
  { code: "PROVIDER_NOT_FOUND", status: 404 },
  { code: "INVALID_ORIGIN", status: 403 },
  { code: "INVALID_OTP", status: 400 },
  { code: "OTP_EXPIRED", status: 400 },
  { status: 429 },
  { status: 503 },
  new TypeError("Failed to fetch"),
  new Error("private@example.test token=secret"),
])("keeps the normalized failure reason through the actual outgoing GA command: %j", error => {
  const document = documentSender()
  const params = authFailureParams(error)
  document.sendProductEvent({ event: "sign_in_failed", params: { method: "google", failure_stage: "social_start", ...params } })
  expect(Array.from(document.dataLayer[0])[2]).toMatchObject(params)
  expect(JSON.stringify(document.dataLayer)).not.toContain("private@example.test")
  expect(JSON.stringify(document.dataLayer)).not.toContain("token=secret")
})

it("does not trust arbitrary reason text even with an approved error code", () => {
  const document = documentSender()
  document.sendProductEvent({ event: "sign_in_failed", params: { error_code: "INVALID_OTP", error_reason: "private@example.test", http_status: "400?token=secret" } })
  expect(Array.from(document.dataLayer[0])[2]).toMatchObject({ error_code: "INVALID_OTP", error_reason: "Invalid OTP" })
  expect(JSON.stringify(document.dataLayer)).not.toContain("private@example.test")
  expect(JSON.stringify(document.dataLayer)).not.toContain("secret")
})


it.each(["http://localhost:3000", "https://preview.alook.ai", "https://alook.ai.evil.test", "http://alook.ai", "https://alook.ai:444"])("does not initialize or send the actual product document on %s", origin => {
  const document = documentSender(origin)
  document.sendProductEvent({ event: "login_page_view", params: {} })
  expect(document.gtag).toBeUndefined()
  expect(document.scripts).toEqual([])
  expect(document.dataLayer).toEqual([])
})

it("initializes only the canonical production Google SDK", () => {
  const document = documentSender()
  expect(document.gtag).toBeTypeOf("function")
  document.gtag?.("event", "queue-helper-contract")
  expect(Array.from(document.dataLayer[0])).toEqual(["event", "queue-helper-contract"])
  expect(document.scripts).toEqual([{ async: true, src: "https://www.googletagmanager.com/gtag/js?id=G-STBCL8F4ZY" }])
})

it.each(ONBOARDING_ANALYTICS_STAGES)("preserves only the approved %s stage in the actual document", stage => {
  const document = documentSender()
  for (const event of ["community_onboarding_stage_completed", "community_onboarding_skipped"]) {
    document.sendProductEvent({ event, params: { stage, private_id: "secret" } })
  }
  expect(document.dataLayer.map(command => Array.from(command)[2])).toEqual(Array(2).fill({ stage, page_location: "https://alook.ai/analytics/product", page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY" }))
})

it.each([undefined, "complete", "bot", "dm", "server", "private@example.test"])("drops missing or unsupported stage %s before the actual GA command", stage => {
  const document = documentSender()
  for (const event of ["community_onboarding_stage_completed", "community_onboarding_skipped"]) document.sendProductEvent({ event, params: { stage } as Record<string, string> })
  expect(document.dataLayer).toEqual([])
})
