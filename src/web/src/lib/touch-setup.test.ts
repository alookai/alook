import { describe, expect, it } from "vitest"
import { parseTouchGrant, parseTouchSetupQr, TOUCH_PROVISION_SERVICE, touchEndpointRequest, touchSetupGuard, touchSetupQueue } from "./touch-setup"

const qr = { ver: "v1", name: "ALOOK_TOUCH_A1B2C3", pop: "0123456789abcdef0123456789abcdef", transport: "ble", security: 1, service_uuid: TOUCH_PROVISION_SERVICE }
describe("Touch setup contracts", () => {
  it("accepts only the named Security1 board and a full random PoP", () => {
    expect(parseTouchSetupQr(JSON.stringify(qr))).toEqual(qr)
    for (const patch of [{ security: 0 }, { pop: "" }, { pop: "abcd" }, { name: "PROV_1234" }, { transport: "softap" }, { service_uuid: "other" }]) expect(() => parseTouchSetupQr(JSON.stringify({ ...qr, ...patch }))).toThrow()
    expect(() => parseTouchSetupQr("x".repeat(513))).toThrow()
    expect(() => parseTouchSetupQr("https://example.com?pop=secret")).toThrow("This is not a Touch setup code.")
  })
  it("keeps the authorization response bounded and excludes other payload fields", () => {
    expect(parseTouchGrant(new TextEncoder().encode('{"state":"ready","user_code":"ABCD-EFGH","token":"ignored"}'))).toEqual({ state: "ready", user_code: "ABCD-EFGH" })
    expect(parseTouchGrant(new TextEncoder().encode('{"state":"pending"}'))).toEqual({ state: "pending" })
    for (const value of ['{"state":"ready","user_code":"secret"}', "x".repeat(257), "null"]) expect(() => parseTouchGrant(new TextEncoder().encode(value))).toThrow()
  })
  it("preserves eight-character server codes and optional display separators through acknowledgement", () => {
    for (const code of ["ABCD2345", "ABCD-2345"]) {
      expect(parseTouchGrant(new TextEncoder().encode(JSON.stringify({ state: "ready", user_code: code })))).toEqual({ state: "ready", user_code: code })
      expect(JSON.parse(touchEndpointRequest("ack", code))).toEqual({ action: "ack", user_code: code })
    }
    for (const code of ["ABCDEFG", "ABCDEFGHI", "ABC-23456", "ABCD--2345", "abcd2345", "ABCD2345\n", "ABCD\u0000234", "ＡBCD2345"]) {
      expect(() => parseTouchGrant(new TextEncoder().encode(JSON.stringify({ state: "ready", user_code: code })))).toThrow()
      expect(() => touchEndpointRequest("ack", code)).toThrow()
    }
  })
  it("serializes encrypted operations and retires queued work before it starts", async () => {
    const controller = new AbortController(), order: string[] = []
    let finish!: () => void
    const serial = touchSetupQueue(touchSetupGuard(controller.signal, () => undefined))
    const first = serial(async () => { order.push("first"); await new Promise<void>(resolve => { finish = resolve }); order.push("done") })
    const second = serial(async () => { order.push("second") })
    const observed = Promise.allSettled([first, second])
    await Promise.resolve(); expect(order).toEqual(["first"])
    controller.abort(); finish()
    expect((await observed).map(value => value.status)).toEqual(["rejected", "rejected"])
    expect(order).toEqual(["first", "done"])
  })
})
