import redCharacter from "../../../public/download/character-red.svg?raw"
import purpleCharacter from "../../../public/download/character-purple.svg?raw"
import tealCharacter from "../../../public/download/character-teal.svg?raw"
import blueCharacter from "../../../public/download/character-blue.svg?raw"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DownloadPageView } from "./download-page"
import { DOWNLOAD_TARGETS, IOS_TESTFLIGHT_URL } from "@/lib/download-platforms"
import { PublicSiteHeader } from "../home/public-site-header"

describe("complete server-rendered download page", () => {
  it("provides every actual installer before JavaScript and uses real Alook preview modules", () => {
    const installers = DOWNLOAD_TARGETS.map(target => ({ id: target.id, version: "1.0.0", bytes: 1000, url: `https://github.com/alookai/alook/releases/download/v1.0.0/${target.id}` }))
    const html = renderToStaticMarkup(createElement(DownloadPageView, { catalog: { installers, unavailable: false } }))
    for (const item of installers) expect(html).toContain(`href="${item.url}"`)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    const document = new JSDOM(html).window.document
    const devices = document.querySelector('[role="group"][aria-label="Alook on desktop and mobile"]')!
    expect(devices.querySelectorAll('img[src^="/download/character-"]')).toHaveLength(4)
    expect(document.querySelectorAll('img[src^="/download/character-"]')).toHaveLength(4)
    expect(devices.querySelector('[aria-label="The same Alook room updating on desktop and mobile"]')).not.toBeNull()

    expect(html).toContain('/landing/posters/machine.webp')
    expect(html).toContain('/landing/posters/mobile.webp')
    expect(html).toContain('/download/character-purple.svg')
    expect(html).toContain('/download/character-teal.svg')
    expect(html).toContain('/download/character-red.svg')
    expect(html).toContain('/download/character-blue.svg')
    expect(html).not.toContain('/download/character-orange.svg')
    expect(html).not.toContain("Find your chip")
    expect(html.replaceAll('%2F', '/')).toContain('/download/testflight.png')
    expect(html).toContain('iPhone &amp; iPad')
    expect(html).toContain('Public beta')
    expect(html).toContain('href="https://alook.ai/c/invite/nC7ax53lwm"')
    const mobile = html.slice(html.indexOf('id="mobile"'), html.indexOf('aria-labelledby="browser-heading"'))
    expect(mobile).toContain(`href="${IOS_TESTFLIGHT_URL}"`)
    expect(mobile.indexOf(IOS_TESTFLIGHT_URL)).toBeLessThan(mobile.indexOf('id="android"'))
    expect(mobile).not.toContain('href="/c/me"')
    expect(mobile).not.toContain("while Google Play")
    expect(html).toContain('id="macos" open=""')
    expect(html).toContain('id="windows" open=""')
    expect(html).toContain('id="linux" open=""')
    expect(html.match(/Coming soon/g)).toHaveLength(2)
    expect(html).not.toMatch(/href="[^\"]*(?:apps\.apple|play\.google)/)
    expect(html).toContain('href="/c/me"')
    expect(html).toContain('href="https://github.com/alookai/alook/releases"')
  })

  it("keeps browsing/release fallbacks and store status when the catalog cannot load", () => {
    const html = renderToStaticMarkup(createElement(DownloadPageView, { catalog: { installers: [], unavailable: true } }))
    expect(html).toContain("We couldn’t load the download list.")
    expect(html.match(/Not available right now/g)).toHaveLength(8)
    expect(html.match(/Coming soon/g)).toHaveLength(2)
    expect(html).not.toContain("/releases/download/")
    expect(html).toContain('href="/c/me"')
  })

  // Subpages now share the home page's bar (QA #14): no separate "Back to home"
  // link; the logo goes home and Get started leads to sign-in.
  it.each(["/contact", "/download"])("shares the home page's marketing bar and real navigation: %s", currentPath => {
    const html = renderToStaticMarkup(createElement(PublicSiteHeader, { currentPath }))
    expect(html).toContain('aria-label="Alook home"')
    expect(html).toContain('aria-label="Site navigation"')
    expect(html).toContain('href="/download"')
    expect(html).toContain('href="/contact"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('class="marketing-nav')
    expect(html).toContain('href="/sign-in"')
  })
})

it.each(["red", "purple", "teal", "blue"])("paints the real %s logo expression in the download asset", color => {
  const svg = { red: redCharacter, purple: purpleCharacter, teal: tealCharacter, blue: blueCharacter }[color]
  expect(svg).toMatch(/data-part="expression"\s+opacity="1"/)
  expect(svg).not.toMatch(/opacity="0"/)
})
