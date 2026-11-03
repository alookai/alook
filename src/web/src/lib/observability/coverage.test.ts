import { expect, it } from "vitest"
import { routeTemplate } from "./coverage"

it("normalizes the ordinary message route without retaining a message ID or query", () => {
  expect(routeTemplate("/c/messages/private_message_188?seq=123")).toBe("/c/messages/[messageId]")
})
