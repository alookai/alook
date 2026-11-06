import { act, render } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  desktop: true,
  tauri: true,
  theme: "light" as string | undefined,
}))

vi.mock("@alook/shared", () => ({
  isDesktop: () => mocks.desktop,
  isTauri: () => mocks.tauri,
  tauriInvoke: mocks.invoke,
}))
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: mocks.theme }) }))

import { readTauriWindowBackground, TauriThemeSync } from "./tauri-theme-sync"

let meta: HTMLMetaElement
let pixels: number[]
let drawn: string

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined)
  mocks.desktop = mocks.tauri = true
  mocks.theme = "light"
  meta = document.createElement("meta")
  meta.name = "theme-color"
  meta.content = "rgb(224, 213, 192)"
  document.head.appendChild(meta)
  pixels = [224, 213, 192, 255]
  drawn = ""
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    set fillStyle(value: string) { drawn = value },
    fillRect() {},
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  meta.remove()
  vi.restoreAllMocks()
})

async function mount() {
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<TauriThemeSync />) })
  return view
}

describe("desktop published surface synchronization", () => {
  it("reads the publication and resynchronizes after navigation without a theme change", async () => {
    const view = await mount()
    expect(drawn).toBe("rgb(224, 213, 192)")
    expect(mocks.invoke).toHaveBeenCalledWith("set_window_theme", { dark: false, background: [224, 213, 192] })

    meta.content = "rgb(255, 253, 248)"
    pixels = [255, 253, 248, 255]
    await act(async () => { window.dispatchEvent(new Event("alook:theme-color-change")) })
    expect(drawn).toBe("rgb(255, 253, 248)")
    expect(mocks.invoke.mock.calls.slice(-2)).toEqual([
      ["set_window_theme", { dark: false, background: [255, 253, 248] }],
      ["close_splashscreen"],
    ])

    view.unmount()
    mocks.invoke.mockClear()
    window.dispatchEvent(new Event("alook:theme-color-change"))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("replaces the theme listener when the resolved theme changes", async () => {
    const view = await mount()
    mocks.theme = "dark"
    meta.content = "rgb(13, 13, 13)"
    pixels = [13, 13, 13, 255]
    await act(async () => { view.rerender(<TauriThemeSync />) })
    mocks.invoke.mockClear()
    await act(async () => { window.dispatchEvent(new Event("alook:theme-color-change")) })
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: true, background: [13, 13, 13] }],
      ["close_splashscreen"],
    ])
  })

  it("uses document paint before publication and rejects translucent samples", () => {
    meta.remove()
    const readStyle = vi.fn().mockReturnValue({ backgroundColor: "body-paint" })
    expect(readTauriWindowBackground(document, readStyle)).toEqual([224, 213, 192])
    expect(drawn).toBe("body-paint")
    expect(readStyle).toHaveBeenCalledWith(document.body)
    pixels = [224, 213, 192, 128]
    expect(readTauriWindowBackground(document, readStyle)).toBeNull()
  })

  it.each(["missing context", "canvas error"])("still completes startup after %s", async failure => {
    const context = vi.mocked(HTMLCanvasElement.prototype.getContext)
    if (failure === "missing context") context.mockReturnValue(null)
    else context.mockImplementation(() => { throw new Error("canvas unavailable") })
    await mount()
    expect(mocks.invoke.mock.calls).toEqual([
      ["set_window_theme", { dark: false }],
      ["close_splashscreen"],
    ])
  })

  it.each(["mobile", "browser", "unresolved"])("does not send desktop commands for %s", async mode => {
    if (mode === "mobile") mocks.desktop = false
    if (mode === "browser") mocks.tauri = false
    if (mode === "unresolved") mocks.theme = undefined
    await mount()
    await act(async () => { window.dispatchEvent(new Event("alook:theme-color-change")) })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
