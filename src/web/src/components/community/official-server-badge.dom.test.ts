import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { OfficialServerBadge } from "./official-server-badge"

describe("official server badge asset", () => {
  it("loads as a standalone SVG without reflective effects", () => {
    render(createElement(OfficialServerBadge, { official: true }))
    const badge = screen.getByRole("img", { name: "Official server" })
    expect(badge).toHaveAttribute("src", "/official-server-badge-flat.svg")
    const asset = readFileSync(resolve(
      import.meta.dirname,
      "../../../public",
      badge.getAttribute("src")!.slice(1),
    ), "utf8")
    const document = new DOMParser().parseFromString(asset, "image/svg+xml")
    expect(document.querySelector("parsererror")).toBeNull()
    expect(document.documentElement.localName).toBe("svg")
    expect(document.documentElement.getAttribute("viewBox")).toBe("0 0 24 24")
    expect(document.querySelector("linearGradient, radialGradient, filter")).toBeNull()
  })
})
