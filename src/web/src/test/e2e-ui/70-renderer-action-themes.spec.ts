import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/case-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { confirmCommunityFixtureApiResponse, CURRENT_COMMUNITY_FIXTURE_HEADERS } from "./_fixtures/business-contract"
import { tid } from "./_fixtures/testids"

const HTML = '<!doctype html><html><body><p>Renderer action theme fixture</p><button style="position:absolute;right:6px;top:6px;width:24px;height:24px;padding:0" aria-label="Use preview" onclick="document.querySelector(\'output\').textContent=Number(document.querySelector(\'output\').textContent)+1">+</button><output>0</output></body></html>'
const TABLE_ACTIONS = ':scope > div:first-child:not(:has([data-streamdown="table"]))'

async function colors(control: Locator, group: Locator) {
  const palette = await control.evaluate(() => {
    const reference = document.createElement("span")
    reference.style.display = "none"
    document.body.appendChild(reference)
    try {
      const read = (name: string) => {
        reference.style.color = `var(--${name})`
        return getComputedStyle(reference).color
      }
      return { foreground: read("foreground"), mutedForeground: read("muted-foreground"), muted: read("muted"), popover: read("popover") }
    } finally { reference.remove() }
  })
  const button = await control.evaluate(element => {
    const style = getComputedStyle(element)
    return { foreground: style.color, background: style.backgroundColor,
      focused: document.activeElement === element, focusVisible: element.matches(":focus-visible") }
  })
  return { palette, button, background: await group.evaluate(element => getComputedStyle(element).backgroundColor) }
}

async function activeColors(control: Locator, group: Locator) {
  await expect.poll(async () => {
    const result = await colors(control, group)
    return result.button.foreground === result.palette.foreground && result.button.background === result.palette.muted
      && result.background === result.palette.popover
  }).toBe(true)
}

async function inspectControl(page: Page, group: Locator, control: Locator, inline: boolean, block: Locator) {
  await expect(control).toBeEnabled()
  await control.scrollIntoViewIfNeeded()
  await control.evaluate(element => (element as HTMLElement).blur())
  await page.mouse.move(0, 0)
  await expect.poll(async () => {
    const result = await colors(control, group)
    return result.button.foreground === (inline ? result.palette.mutedForeground : result.palette.foreground)
      && result.button.background === "rgba(0, 0, 0, 0)"
  }).toBe(true)
  if (inline) {
    await expect(control).toHaveCSS("width", "24px")
    await expect(control).toHaveCSS("height", "24px")
    await expect(control.locator("svg")).toHaveCSS("width", "14px")
    await expect(control.locator("svg")).toHaveCSS("height", "14px")
  }
  await block.hover()
  await control.hover()
  await expect(group).toHaveCSS("opacity", "1")
  await activeColors(control, group)
  const hover = await colors(control, group)
  await page.mouse.move(0, 0)
  await page.keyboard.press("Tab")
  await control.focus()
  await expect(control).toBeFocused()
  await expect.poll(() => control.evaluate(element => element.matches(":focus-visible"))).toBe(true)
  await expect(group).toHaveCSS("opacity", "1")
  await activeColors(control, group)
  return { hover, focus: await colors(control, group) }
}

async function inspectGroup(page: Page, block: Locator, group: Locator, titles: string[]) {
  await block.scrollIntoViewIfNeeded()
  await block.hover()
  await expect(group).toHaveCSS("opacity", "1")
  await expect(group.getByRole("button")).toHaveCount(titles.length)
  const results = []
  for (const title of titles) results.push({ title, ...await inspectControl(page, group, group.getByRole("button", { name: title, exact: true }), true, block) })
  return results
}

async function inspectMenu(page: Page, block: Locator, group: Locator, trigger: string, options: string[]) {
  await group.getByTitle(trigger, { exact: true }).click()
  const menu = group.locator(".absolute")
  await expect(menu).toHaveCount(1)
  await expect(menu.getByRole("button")).toHaveCount(options.length)
  const results = []
  for (const title of options) {
    results.push({ title, ...await inspectControl(page, menu, menu.getByTitle(title, { exact: true }), false, block) })
    await expect(group).toHaveCSS("opacity", "1")
  }
  await group.getByTitle(trigger, { exact: true }).click()
  await expect(menu).toHaveCount(0)
  return results
}

for (const viewport of [{ width: 390, height: 844 }, { width: 834, height: 1112 }, { width: 1280, height: 900 }]) {
  test(`shared renderer actions use readable theme pairs on hover and focus at ${viewport.width}px`, async ({ caseActors }, testInfo) => {
    test.setTimeout(120_000)
    const actors = await caseActors(["alice"])
    const serverId = await actors.seed.seedServer("alice", `Action themes ${Date.now()}`)
    const channelId = await actors.seed.seedChannel("alice", serverId, "action-themes")
    const codeId = await actors.seed.seedMessage("alice", channelId, '```javascript\nconsole.log("theme");\n```')
    const redactedId = await actors.seed.seedMessage("alice", channelId, '```text\nvalue=[REDACTED_SECRET]\n```')
    const mermaidId = await actors.seed.seedMessage("alice", channelId, "```mermaid\nflowchart LR\nA[Start] --> B[End]\n```")
    const tableId = await actors.seed.seedMessage("alice", channelId, "| Name | Value |\n| --- | --- |\n| Theme | Readable |")
    const { page } = await actors.asUser("alice", { viewport, hasTouch: viewport.width < 1280,
      isMobile: viewport.width === 390, reducedMotion: "reduce", colorScheme: "light" })
    await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
    await expect.poll(() => page.evaluate(() => localStorage.getItem("theme") || "system")).toBe("system")
    const upload = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${channelId}/attachments`, {
      headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
      multipart: { file: { name: "theme.html", mimeType: "text/html", buffer: Buffer.from(HTML) } },
    }))
    expect(upload.status()).toBe(200)
    const attachmentId = (await upload.json() as { id: string }).id
    const posted = await confirmCommunityFixtureApiResponse(page.request.post(`/api/community/channels/${channelId}/messages`, {
      headers: CURRENT_COMMUNITY_FIXTURE_HEADERS,
      data: { content: `[alook-html-preview](${attachmentId})`, attachments: [attachmentId] },
    }))
    expect(posted.status()).toBe(201)
    const htmlMessageId = (await posted.json() as { message: { id: string } }).message.id
    const preview = page.getByTestId(tid.message(htmlMessageId)).getByTestId(tid.htmlPreview(attachmentId))
    await preview.scrollIntoViewIfNeeded()
    await expect(preview).toHaveAttribute("data-html-preview-status", "ready")
    const mermaid = page.getByTestId(tid.message(mermaidId)).locator('[data-streamdown="mermaid-block"]')
    await mermaid.scrollIntoViewIfNeeded()
    await expect(mermaid.locator("svg .node")).toHaveCount(2)
    const messageWrites: string[] = []
    const rawHtmlRequests: string[] = []
    page.on("request", request => {
      const url = new URL(request.url())
      if (request.method() !== "GET" && /\/api\/community\/(?:channels\/[^/]+\/messages|messages\/[^/]+)$/.test(url.pathname)) {
        messageWrites.push(`${request.method()} ${url.pathname}`)
      }
      if (url.pathname === `/api/community/channels/${channelId}/attachments/${attachmentId}` && url.searchParams.get("preview") !== "html") rawHtmlRequests.push(request.url())
    })
    const samples = []
    const htmlFrame = preview.getByTestId(tid.htmlPreviewFrame(attachmentId))
    const htmlContent = htmlFrame.contentFrame()
    const htmlHostControls = preview.locator("button, a[download], [data-html-preview-actions]")
    await expect(htmlHostControls).toHaveCount(0)
    await expect(preview.locator(":scope > *")).toHaveCount(1)
    await expect(preview.locator(":scope > iframe")).toHaveCount(1)
    let htmlActivations = 0
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode })
      await expect.poll(() => page.evaluate(() => ({ media: matchMedia("(prefers-color-scheme: dark)").matches,
        html: document.documentElement.classList.contains("dark") }))).toEqual({ media: mode === "dark", html: mode === "dark" })
      for (const [consumer, id] of [["code", codeId], ["redacted", redactedId]] as const) {
        const block = page.getByTestId(tid.message(id)).locator('[data-streamdown="code-block"]')
        if (consumer === "redacted") await expect(block.locator("[data-redacted]")).toHaveCount(1)
        samples.push({ mode, consumer, controls: await inspectGroup(page, block, block.locator('[data-streamdown="code-block-actions"]'), ["Copy Code"]) })
      }
      await mermaid.scrollIntoViewIfNeeded()
      await expect(mermaid.locator("svg .node")).toHaveCount(2)
      const mermaidActions = mermaid.locator('[data-streamdown="mermaid-block-actions"]')
      samples.push({ mode, consumer: "mermaid", controls: await inspectGroup(page, mermaid, mermaidActions, ["Download diagram", "Copy Code", "View fullscreen"]),
        menu: await inspectMenu(page, mermaid, mermaidActions, "Download diagram", ["Download diagram as SVG", "Download diagram as PNG", "Download diagram as MMD"]) })
      const table = page.getByTestId(tid.message(tableId)).locator('[data-streamdown="table-wrapper"]')
      const tableActions = table.locator(TABLE_ACTIONS)
      samples.push({ mode, consumer: "table", controls: await inspectGroup(page, table, tableActions, ["Copy table", "View fullscreen"]),
        menu: await inspectMenu(page, table, tableActions, "Copy table", ["Copy table as Markdown", "Copy table as CSV", "Copy table as TSV"]) })
      await tableActions.getByTitle("View fullscreen", { exact: true }).click()
      const fullscreen = page.locator('[data-streamdown="table-fullscreen"]')
      const fullscreenTable = fullscreen.locator('[data-streamdown="table-wrapper"]')
      const fullscreenActions = fullscreenTable.locator(TABLE_ACTIONS)
      samples.push({ mode, consumer: "fullscreen-table", controls: await inspectGroup(page, fullscreenTable, fullscreenActions, ["Copy table", "Exit fullscreen"]),
        menu: await inspectMenu(page, fullscreenTable, fullscreenActions, "Copy table", ["Copy table as Markdown", "Copy table as CSV", "Copy table as TSV"]) })
      await fullscreenActions.getByTitle("Exit fullscreen", { exact: true }).click()
      await expect(fullscreen).toHaveCount(0)
      await preview.scrollIntoViewIfNeeded()
      await expect(htmlHostControls).toHaveCount(0)
      await preview.hover()
      await expect(htmlHostControls).toHaveCount(0)
      const htmlButton = htmlContent.getByRole("button", { name: "Use preview", exact: true })
      const corner = await htmlButton.boundingBox()
      const frameBounds = await htmlFrame.boundingBox()
      expect(corner).not.toBeNull()
      expect(frameBounds).not.toBeNull()
      expect(Math.abs(frameBounds!.x + frameBounds!.width - corner!.x - corner!.width - 6)).toBeLessThanOrEqual(1)
      expect(Math.abs(corner!.y - frameBounds!.y - 6)).toBeLessThanOrEqual(1)
      await htmlButton.click()
      await expect(htmlContent.locator("output")).toHaveText(String(++htmlActivations))
      await testInfo.attach(`html-preview-host-${viewport.width}-${mode}.png`, { body: await page.screenshot(), contentType: "image/png" })
      await htmlFrame.click({ position: { x: 2, y: 2 } })
      await page.keyboard.press("Tab")
      await expect(htmlButton).toBeFocused()
      await expect(htmlHostControls).toHaveCount(0)
      await page.keyboard.press("Enter")
      await expect(htmlContent.locator("output")).toHaveText(String(++htmlActivations))
      samples.push({ mode, consumer: "html", hostControls: await htmlHostControls.count(), corner, frameBounds, activations: htmlActivations })
      expect(messageWrites).toEqual([])
      expect(rawHtmlRequests).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await testInfo.attach(`renderer-actions-${viewport.width}-themes.json`, { body: JSON.stringify({ viewport,
      input: "shared controls: mouse hover/click and scripted focus after Tab; HTML: click blank iframe area, native Tab/Enter; not a page-start Tab or pure-touch journey",
      media: await page.evaluate(() => ({ coarse: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches })),
      serverId, channelId, codeId, redactedId, mermaidId, tableId, htmlMessageId, attachmentId, messageWrites, rawHtmlRequests, samples }), contentType: "application/json" })
  })
}
