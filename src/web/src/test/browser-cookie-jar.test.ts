import { NextRequest } from "next/server"
import { expect, it } from "vitest"
import { browserCookieHeaders } from "./browser-cookie-jar"

it.each([
  { response: "session=; Path=/; Max-Age=0", expected: undefined },
  { response: "session=fresh; Max-Age=300; Expires=Thu, 01 Jan 1970 00:00:00 GMT", expected: "fresh" },
  { response: "session=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT", expected: undefined },
])("applies real cookie expiry without changing an unrelated cookie: $response", ({ response, expected }) => {
  const headers = browserCookieHeaders(new Headers({ cookie: "session=old; untouched=keep" }), new Headers({ "set-cookie": response }))
  const cookies = new NextRequest("https://fixture.test", { headers }).cookies
  expect(cookies.get("session")?.value).toBe(expected)
  expect(cookies.get("untouched")?.value).toBe("keep")
})
