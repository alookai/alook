import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("official server badge asset", () => {
  it("loads as a standalone SVG without reflective effects", () => {
    const asset = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "public/official-server-badge-flat.svg",
    ), "utf8")
    const document = new DOMParser().parseFromString(asset, "image/svg+xml")
    expect(document.querySelector("parsererror")).toBeNull()
    expect(document.documentElement.localName).toBe("svg")
    expect(document.documentElement.getAttribute("viewBox")).toBe("0 0 24 24")
    expect(document.querySelector("linearGradient, radialGradient, filter")).toBeNull()
  })
})
