import { describe, expect, it } from "vitest"
import { projectMessageWireType } from "./message-wire-type"

describe("projectMessageWireType", () => {
  it("normalizes every stored message discriminator to the canonical wire shape", () => {
    expect(projectMessageWireType("default")).toEqual({ type: "chat" })
    expect(projectMessageWireType("system")).toEqual({ type: "system" })
    expect(projectMessageWireType("thread_created")).toEqual({
      type: "system",
      systemKind: "thread",
    })
  })
})
