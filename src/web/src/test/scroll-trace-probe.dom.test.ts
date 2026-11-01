import type { Page, TestInfo } from "@playwright/test"
import { createElement } from "react"
import { expect, it, vi } from "vitest"
import { mockElementGeometry, render } from "@/test/react-dom-harness"
import { createScrollTraceIdentity, startAnalyzedScrollTrace, validateScrollTrace } from "./e2e-ui/_fixtures/scroll-trace"

it("reinstalls and validates consecutive real probe captures with their analysis window and write cleanup", async () => {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id) })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  const view = render(createElement("div", { "data-testid": "community-message-scroller" },
    createElement("div", { "data-message-list-content": "" },
      createElement("div", { "data-index": 0 }, createElement("div", { "data-msg-id": "m1" }, "row")),
    ),
  ))
  const root = view.getByTestId("community-message-scroller")
  const restoreGeometry = mockElementGeometry(root, { scrollHeight: 1000, clientHeight: 400 })
  const page = {
    addScriptTag: async ({ content }: { content: string }) => { new Function(content)() },
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page
  const attach = vi.fn(async () => {})
  const info = { attach } as unknown as TestInfo
  const advance = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(16)
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
      await Promise.resolve()
    }
  }
  try {
    for (const scenario of ["local-history-submission", "passive-append-position-admission"]) {
      const finish = await startAnalyzedScrollTrace(page, {
        scenario,
        identity: createScrollTraceIdentity({ account: "fixture", channel: "fixture", viewport: { width: 1280, height: 800 } }),
        dataTransitionSource: "overlay-ws",
      })
      await advance(3)
      root.scrollTop = 599
      await advance(2)
      const finished = finish(info)
      await advance(12)
      const result = (await finished)!
      expect(validateScrollTrace(result)).toEqual([])
      expect(result.writes).toEqual(expect.arrayContaining([expect.objectContaining({ method: "scrollTop", args: [599] })]))
      expect(result.marks.map(mark => mark.name)).toEqual(expect.arrayContaining([`analysis-start:${scenario}`, `analysis-end:${scenario}`, "final-stimulus"]))
      expect(Reflect.get(globalThis, "__alookScrollTrace")).toBeUndefined()
      expect(Object.hasOwn(root, "scrollTop")).toBe(false)
      expect(frames.size).toBe(0)
      await expect(finish(info)).resolves.toBeUndefined()
    }
    expect(attach).toHaveBeenCalledTimes(4)
  } finally {
    Reflect.get(globalThis, "__alookScrollTrace")?.abort()
    restoreGeometry()
    view.unmount()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})
