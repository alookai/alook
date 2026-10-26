import { describe, expect, it } from "vitest"
import { creativeCaptures, creativeDocument } from "./capture.mjs"

describe("approved creative documents", () => {
  it.each(creativeCaptures)("composes the $asset artwork without preview controls or retired imagery", capture => {
    const document = new DOMParser().parseFromString(creativeDocument(capture.asset), "text/html")
    const root = document.querySelector<HTMLElement>("#capture-creative")!
    expect([root.style.width, root.style.height]).toEqual([`${capture.width}px`, `${capture.height}px`])
    expect(root.firstElementChild?.className).toBe(`canvas ${capture.asset}-art`)
    expect((root.firstElementChild as HTMLElement).style.transform).toBe(`scale(${capture.width / capture.logicalWidth})`)
    expect(document.querySelector(".headline")?.textContent).toBe("SHARE YOUR AGENTS.")
    expect(document.querySelector(".subline")?.textContent).toBe("with people you trust.")
    expect(document.querySelector(".brand")?.textContent).toBe("Alook")
    expect([...document.querySelectorAll(".face")].map(face => face.getAttribute("src")).sort()).toEqual(["blue", "purple", "red", "teal"].map(color => `/faces/face-${color}.svg`))
    expect(document.querySelectorAll("[data-creative-critical]")).toHaveLength(8)
    expect(document.querySelector(".brand img")?.getAttribute("src")).toBe("/alook.svg")
    expect(document.querySelectorAll("img")).toHaveLength(5)
    expect(document.querySelector("iframe, .app-window, .face-orange, .margin-guide, .toolbar, button, footer")).toBeNull()
    expect(document.querySelector("script")).toBeNull()
  })

  it("rejects an unknown document instead of inserting request text", () => {
    expect(() => creativeDocument("<img src=bad>")).toThrow("Invalid creative asset")
    expect(() => creativeDocument("all")).toThrow("A document requires")
    expect(creativeDocument()).toBe(creativeDocument("header"))
  })
})
