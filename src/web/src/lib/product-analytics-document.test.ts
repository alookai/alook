import rawContractInput0 from "../../public/analytics-events.html?raw"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { LANDING_CTA_NAMES, ONBOARDING_ANALYTICS_STAGES, PRODUCT_ANALYTICS_EVENTS } from "./product-analytics-contract"
import { authFailureParams } from "./auth-failure"

function documentSender(origin = "https://alook.ai") {
  const html = rawContractInput0
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error("missing event document script")
  const window = { gtag: undefined as ((...args: unknown[]) => void) | undefined, dataLayer: [] as ArrayLike<unknown>[], sendProductEvent: (_input: { event: string; params: Record<string, unknown> }) => {} }
  const scripts: { src?: string; async?: boolean }[] = []
  const document = { createElement: () => ({}), head: { appendChild: (script: { src?: string; async?: boolean }) => scripts.push(script) } }
  runInNewContext(script, { window, document, location: { origin } })
  window.dataLayer.length = 0
  return { ...window, scripts }
}

describe("actual isolated product-event document", () => {
  it("accepts fixed connection and reply dimensions without forwarding private inputs", () => {
    const document = documentSender()
    document.sendProductEvent({ event: "runtime_connected", params: { surface: "private-user", connection_type: "private-machine", user_id: "private-owner" } })
    document.sendProductEvent({ event: "first_agent_reply_persisted", params: { conversation_type: "thread", channel_id: "private-channel", page_location: "https://alook.ai/c/private" } })
    document.sendProductEvent({ event: "first_agent_reply_persisted", params: { conversation_type: "private-message" } })
    const commands = document.dataLayer.map(command => Array.from(command))
    expect(commands.map(command => command[1])).toEqual(["runtime_connected", "first_agent_reply_persisted"])
    expect(commands[0][2]).toMatchObject({ surface: "community", connection_type: "local_daemon" })
    expect(commands[1][2]).toMatchObject({ surface: "community", conversation_type: "thread" })
    expect(JSON.stringify(commands)).not.toContain("private-")
    expect(JSON.stringify(commands)).not.toContain("/c/private")
  })
  it("accepts exactly the finite names while keeping fixed private-page metadata", () => {
    const document = documentSender()
    const pricing = { plan_id: "studio", cta_id: "billing_studio", cta_action: "choose_plan", auth_state: "signed_in", current_plan: "free", entry_point: "billing_sheet" }
    const checkout = { currency: "USD", value: 20, items: [{ item_id: "studio", item_name: "Studio", price: 20, quantity: 1 }], entry_point: "billing_sheet" }
    for (const event of PRODUCT_ANALYTICS_EVENTS) document.sendProductEvent({ event, params: { private_id: "secret", page_location: "https://private.test/token", method: "private", failure_stage: "private", stage: "harness", conversation_type: "thread", cta_name: "get_started", ...(event === "pricing_cta_click" ? pricing : {}), ...(event === "begin_checkout" ? checkout : {}) } })
    document.sendProductEvent({ event: "unknown", params: {} })
    const commands = document.dataLayer.map(command => Array.from(command))
    expect(commands).toHaveLength(PRODUCT_ANALYTICS_EVENTS.length)
    expect(commands.map(command => command[1])).toEqual([...PRODUCT_ANALYTICS_EVENTS])
    for (const command of commands) expect(command[2]).toEqual({ page_location: "https://alook.ai/analytics/product", page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY", ...(["community_onboarding_stage_completed", "community_onboarding_skipped"].includes(String(command[1])) ? { stage: "harness" } : {}), ...(command[1] === "runtime_connected" ? { surface: "community", connection_type: "local_daemon" } : {}), ...(command[1] === "first_agent_reply_persisted" ? { surface: "community", conversation_type: "thread" } : {}), ...(command[1] === "landing_cta_clicked" ? { cta_name: "get_started" } : {}), ...(command[1] === "pricing_cta_click" ? pricing : {}), ...(command[1] === "begin_checkout" ? checkout : {}) })
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
  for (const event of ["community_onboarding_stage_completed", "community_onboarding_skipped"]) document.sendProductEvent({ event, params: { stage } as Record<string, unknown> })
  expect(document.dataLayer).toEqual([])
})

it("rejects arbitrary CTA text in the actual document", () => {
  const document = documentSender()
  document.sendProductEvent({ event: "landing_cta_clicked", params: { cta_name: "private@example.test" } })
  expect(document.dataLayer).toEqual([])
})

it.each([
  ["/", "https://alook.ai/"],
  ["/blog/introducing-alook", "https://alook.ai/blog/introducing-alook"],
  ["/blog/post?token=private", "https://alook.ai/analytics/product"],
  ["/c/private", "https://alook.ai/analytics/product"],
])("uses only a public source path for a handed-off landing CTA %s", (source_path, page_location) => {
  const document = documentSender()
  document.sendProductEvent({ event: "landing_cta_clicked", params: { cta_name: "get_started", source_path } })
  expect(Array.from(document.dataLayer[0])[2]).toEqual({ cta_name: "get_started", page_location, page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY" })
})

it.each(LANDING_CTA_NAMES)("accepts the existing finite CTA %s", cta_name => {
  const document = documentSender()
  document.sendProductEvent({ event: "landing_cta_clicked", params: { cta_name } })
  expect(Array.from(document.dataLayer[0])[2]).toMatchObject({ cta_name })
})

it("canonicalizes billing fields in the real receiver without identifiers or mutable labels", () => {
  const document = documentSender()
  document.sendProductEvent({ event: "begin_checkout", params: { currency: "usd", value: 20, items: [{ item_id: "studio", item_name: "private@example.test", price: 20, quantity: 1, token: "private-token" }], entry_point: "billing_sheet", user_id: "private-owner", page_location: "https://alook.ai/c/private" } })
  const command = Array.from(document.dataLayer[0])
  expect(command).toEqual(["event", "begin_checkout", { currency: "USD", value: 20, items: [{ item_id: "studio", item_name: "Studio", price: 20, quantity: 1 }], entry_point: "billing_sheet", page_location: "https://alook.ai/analytics/product", page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY" }])
})

it.each([
  { value: -1 }, { value: Number.NaN }, { value: "20" }, { currency: "private-token" },
  { entry_point: "private-channel" }, { items: [{ item_id: "private-plan", price: 20, quantity: 1 }] },
  { items: [{ item_id: "studio", price: 19, quantity: 1 }] }, { items: [{ item_id: "studio", price: 20, quantity: 2 }] },
])("drops invalid checkout data in the actual receiver: %j", invalid => {
  const document = documentSender()
  document.sendProductEvent({ event: "begin_checkout", params: { currency: "USD", value: 20, items: [{ item_id: "studio", price: 20, quantity: 1 }], entry_point: "billing_sheet", ...invalid } })
  expect(document.dataLayer).toEqual([])
})

it.each([
  { plan_id: "private-plan" }, { cta_id: "pricing_studio" }, { cta_action: "private-action" },
  { auth_state: "private-owner" }, { current_plan: "private-plan" }, { entry_point: "private-channel" },
])("drops invalid pricing dimensions in the actual receiver: %j", invalid => {
  const document = documentSender()
  document.sendProductEvent({ event: "pricing_cta_click", params: { plan_id: "studio", cta_id: "billing_studio", cta_action: "choose_plan", auth_state: "signed_in", current_plan: "free", entry_point: "billing_sheet", ...invalid } })
  expect(document.dataLayer).toEqual([])
})
