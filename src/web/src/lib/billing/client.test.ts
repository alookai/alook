import { expect, it } from "vitest"
import { billingOrigin } from "./client"

it.each(["http://alook.ai", "ftp://alook.ai"])("rejects unsafe billing return origin %s", (origin) => {
  expect(() => billingOrigin({ STRIPE_RETURN_ORIGIN: origin } as Env)).toThrow("BILLING_UNAVAILABLE")
})
