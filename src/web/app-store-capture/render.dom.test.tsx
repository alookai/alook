import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import CaptureLayout from "./app/layout"
import CapturePage from "./app/page"
import { Artwork } from "./captures/poster"

vi.mock("next/font/local", () => ({
  default: ({ variable }: { variable: string }) => ({ variable }),
}))

function documentFor(element: Parameters<typeof renderToStaticMarkup>[0]) {
  return new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html")
}

const posterQueries: [Record<string, string | string[] | undefined>, string, string | null, string][] = [
  [{}, "phone", "1", "1206px"],
  [{ story: "6", large: "1" }, "phone", "6", "1320px"],
  [{ story: "0" }, "phone", "1", "1206px"],
  [{ story: "7" }, "phone", "1", "1206px"],
  [{ story: "invalid", kind: ["duo"] }, "phone", "1", "1206px"],
  [{ kind: "tablet" }, "tablet", "1", "2752px"],
  [{ kind: "tablet", story: "4" }, "tablet", "4", "2752px"],
  [{ kind: "duo" }, "duo", "1", "2007px"],
  [{ kind: "duo", story: "5" }, "duo", "5", "2007px"],
]

describe("App Store capture document and poster entry", () => {
  it("keeps the shared font variables and body content on the root document", () => {
    const document = documentFor(<CaptureLayout><main>Capture content</main></CaptureLayout>)
    expect(document.documentElement.lang).toBe("en")
    expect([...document.documentElement.classList]).toEqual([
      "--font-dm-sans", "--font-dm-mono", "--font-instrument-serif", "--font-caveat",
      "--font-vt323", "--font-literata", "antialiased",
    ])
    expect(document.body.querySelector("main")?.textContent).toBe("Capture content")
  })

  it.each([
    [1, "Multi-AgentCollaboration", ["workspace", "reply"]],
    [2, "LET TEAMMATESTALK TO YOURAGENT.", ["workspace", "reply"]],
    [3, "A COMPANIONOF YOUROWN.", ["identity", "profile"]],
    [4, "PICK UPWHERE YOULEFT OFF.", ["continuity", "continuity-ask", "continuity-answer"]],
    [5, "CHECK INFROM YOURPHONE.", ["workspace", "composer"]],
    [6, "KEEP YOUREXISTINGSETUP.", ["workspace", "workspace"]],
  ] as const)("renders story %s with its own headline and live surface destinations", (story, heading, scenes) => {
    for (const large of [false, true]) {
      const document = documentFor(<Artwork kind="phone" story={story} large={large} />)
      const canvas = document.querySelector<HTMLElement>("#capture-poster")!
      expect([canvas.style.width, canvas.style.height]).toEqual(large ? ["1320px", "2868px"] : ["1206px", "2622px"])
      expect(document.querySelector("h1")?.textContent).toBe(heading)
      expect(document.querySelector("[data-story]")?.getAttribute("data-story")).toBe(String(story))
      expect([...document.querySelectorAll("iframe")].map(frame => new URL(frame.src).searchParams.get("scene"))).toEqual(scenes)
      expect([...document.querySelectorAll(".art-face, .scattered-face")].every(face => face.getAttribute("src")?.startsWith("/faces/face-"))).toBe(true)
      const poster = document.querySelector<HTMLElement>(".phone-poster")!
      expect(poster.style.transform).toBe(large ? `scale(${1320 / 1206})` : "")
    }
  })

  it.each(["phone", "tablet", "duo"])("renders all six %s stories from their own real component scenes without outer branding", (kind) => {
    const scenes = [
      ["workspace", "reply"], ["workspace", "reply"], ["identity", "profile"],
      ["continuity", "continuity-ask", "continuity-answer"], ["workspace", "composer"],
      kind === "tablet" ? ["workspace", "provider"] : ["workspace", "workspace"],
    ]
    for (let story = 1; story <= 6; story++) {
      const document = documentFor(<Artwork kind={kind} story={story} large={false} />)
      expect(document.querySelector("[data-story]")?.getAttribute("data-story")).toBe(String(story))
      expect([...document.querySelectorAll("iframe")].map(frame => new URL(frame.src).searchParams.get("scene"))).toEqual(scenes[story - 1])
      expect(document.querySelector(".brand, .number, .crease")).toBeNull()
      expect(document.querySelector("h1")?.textContent?.length).toBeGreaterThan(10)
      if (kind === "duo") {
        expect(document.querySelector(".unfolded") !== null).toBe(story !== 5)
        expect(document.querySelector(".folded") !== null).toBe([3, 5, 6].includes(story))
      }
    }
  })

  it("preserves the complete tablet viewport and independent Duo screen geometry", () => {
    const tablet = documentFor(<Artwork kind="tablet" story={1} large={false} />)
    expect(tablet.querySelector<HTMLElement>("#capture-poster")?.style.width).toBe("2752px")
    expect(tablet.querySelector<HTMLElement>("#capture-poster")?.style.height).toBe("2064px")
    expect(tablet.querySelector("iframe")?.getAttribute("width")).toBe("1280")
    expect(tablet.querySelector("iframe")?.getAttribute("height")).toBe("800")
    expect(tablet.querySelector(".number, .brand")).toBeNull()
    const duo = documentFor(<Artwork kind="duo" story={6} large={false} />)
    expect(duo.querySelector<HTMLElement>("#capture-poster")?.style.width).toBe("2007px")
    expect(duo.querySelector<HTMLElement>("#capture-poster")?.style.height).toBe("2853px")
    const screens = [...duo.querySelectorAll("iframe")]
    expect(screens.map(frame => [frame.width, frame.height])).toEqual([["951", "669"], ["466", "678"]])
    for (const frame of screens) {
      const parent = frame.parentElement!
      const scale = Math.min(parseFloat(parent.style.width) / Number(frame.width), parseFloat(parent.style.height) / Number(frame.height))
      expect(frame.style.transform).toBe(`scale(${scale})`)
      expect(parseFloat(frame.style.left)).toBeCloseTo((parseFloat(parent.style.width) - Number(frame.width) * scale) / 2)
      expect(parseFloat(frame.style.top)).toBeCloseTo((parseFloat(parent.style.height) - Number(frame.height) * scale) / 2)
    }
    expect(duo.querySelector(".number, .brand")).toBeNull()
    expect(duo.querySelectorAll(".face")).toHaveLength(5)
  })

  it.each(posterQueries)("resolves the awaited query %j before composing its poster", async (query, kind, story, width) => {
    const element = await CapturePage({ searchParams: Promise.resolve(query) })
    const document = documentFor(element)
    expect(document.querySelector(`.${kind === "phone" ? "phone" : kind}-poster`)).not.toBeNull()
    expect(document.querySelector("[data-story]")?.getAttribute("data-story") ?? null).toBe(story)
    expect(document.querySelector<HTMLElement>("#capture-poster")?.style.width).toBe(width)
  })
})
