import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { PRODUCT_ANALYTICS_EVENTS } from "./product-analytics-contract"

function documentSender() {
  const html = readFileSync(new URL("../../public/analytics-events.html", import.meta.url), "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error("missing event document script")
  const window = { dataLayer: [] as ArrayLike<unknown>[], sendProductEvent: (_input: { event: string; params: Record<string, string> }) => {} }
  runInNewContext(script, { window })
  window.dataLayer.length = 0
  return window
}

describe("actual isolated product-event document", () => {
  it("accepts exactly the twelve finite names while keeping fixed private-page metadata", () => {
    const document = documentSender()
    for (const event of PRODUCT_ANALYTICS_EVENTS) document.sendProductEvent({ event, params: { private_id: "secret", page_location: "https://private.test/token", method: "private", failure_stage: "private" } })
    document.sendProductEvent({ event: "unknown", params: {} })
    const commands = document.dataLayer.map(command => Array.from(command))
    expect(commands).toHaveLength(12)
    expect(commands.map(command => command[1])).toEqual([...PRODUCT_ANALYTICS_EVENTS])
    for (const command of commands) expect(command[2]).toEqual({ page_location: "https://alook.ai/analytics/product", page_referrer: "", page_title: "Alook", send_to: "G-STBCL8F4ZY" })
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
