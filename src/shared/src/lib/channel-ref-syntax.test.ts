import { describe, expect, it } from "vitest"
import { extractChannelRefsFromText } from "./channel-ref-syntax"

describe("extractChannelRefsFromText", () => {
  it("extracts channel and thread refs while skipping inline code and fenced code blocks", () => {
    const content = [
      "Check /Alook#5620/fix/#381#12, (/Studio#0042/general)，and /Alook#5620/fix。",
      "Ignore `/Alook#5620/fix/#999` and ``/Alook#5620/fix/#998``.",
      "```ts",
      "const ignored = '/Alook#5620/fix/#997'",
      "```",
      "Also ignore https://example.com/Alook#5620/fix/#996",
    ].join("\n")
    expect(extractChannelRefsFromText(content)).toEqual([
      "/Alook#5620/fix/#381#12",
      "/Studio#0042/general",
      "/Alook#5620/fix",
    ])
  })

  it("returns empty array fast when text has no slash", () => {
    expect(extractChannelRefsFromText("plain message without refs")).toEqual([])
  })
})
