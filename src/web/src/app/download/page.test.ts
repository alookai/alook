import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"
import { afterEach, expect, it, vi } from "vitest"
import { DOWNLOAD_TARGETS } from "@/lib/download-platforms"
import DownloadPage from "./page"

const state = vi.hoisted(() => ({ agent: "" }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": state.agent }) }))
vi.mock("@/lib/download-catalog", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/download-catalog")>(),
  readDownloadCatalog: async () => ({ unavailable: false, installers: DOWNLOAD_TARGETS.map(target => ({ id: target.id, version: "1.0.0", bytes: 1000, url: `https://github.com/alookai/alook/releases/download/v1.0.0/${target.id}` })) }),
}))
afterEach(() => { state.agent = "" })

it("uses the installed parser at request time and keeps both chip links for a masked Intel Mac UA", async () => {
  state.agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  const html = renderToStaticMarkup(await DownloadPage())
  const hero = html.slice(html.indexOf('aria-labelledby="download-heading"'), html.indexOf('id="desktop"'))
  expect(hero).toContain('href="https://github.com/alookai/alook/releases/download/v1.0.0/mac-arm"')
  expect(hero).toContain('href="https://github.com/alookai/alook/releases/download/v1.0.0/mac-intel"')
  expect(hero).not.toContain('href="#macos"')
})

it("offers the actual Windows EXE in server HTML before Client Hints or JavaScript", async () => {
  state.agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  const html = renderToStaticMarkup(await DownloadPage())
  const hero = html.slice(html.indexOf('aria-labelledby="download-heading"'), html.indexOf('id="desktop"'))
  expect(hero).toContain('href="https://github.com/alookai/alook/releases/download/v1.0.0/windows-exe"')
  expect(hero).not.toContain('href="#windows"')
})

it("offers the same real TestFlight beta from the iPhone hero and above Android APK", async () => {
  state.agent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  const html = renderToStaticMarkup(await DownloadPage())
  const hero = html.slice(html.indexOf('aria-labelledby="download-heading"'), html.indexOf('id="desktop"'))
  expect(hero).toContain('href="https://testflight.apple.com/join/4fHgVBVF"')
  const { window } = new JSDOM(html)
  try {
    const group = window.document.querySelector('[role="group"][aria-label="Store availability"]')
    expect(group).not.toBeNull()
    expect(Array.from(group!.querySelectorAll("a"), link => link.getAttribute("href"))).toEqual([
      "https://apps.apple.com/app/alook-ai/id6808140039",
      "https://play.google.com/store/apps/details?id=ai.alook.android",
    ])
  } finally {
    window.close()
  }
  expect(html.match(/href="https:\/\/testflight.apple.com\/join\/4fHgVBVF"/g)).toHaveLength(2)
})
