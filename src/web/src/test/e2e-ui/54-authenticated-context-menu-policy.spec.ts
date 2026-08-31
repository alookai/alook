import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./_fixtures/community-fixture"
import { composerEditable, gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"

type ContextMenuProbe = {
  defaultPrevented: boolean | null
  bubbled: boolean
}

async function observeNextContextMenu(page: Page) {
  await page.evaluate(() => {
    const state = window as typeof window & { __authenticatedContextMenuProbe?: ContextMenuProbe }
    state.__authenticatedContextMenuProbe = { defaultPrevented: null, bubbled: false }
    document.addEventListener("contextmenu", (event) => {
      setTimeout(() => {
        if (state.__authenticatedContextMenuProbe) {
          state.__authenticatedContextMenuProbe.defaultPrevented = event.defaultPrevented
        }
      })
    }, { capture: true, once: true })
    document.addEventListener("contextmenu", () => {
      if (state.__authenticatedContextMenuProbe) {
        state.__authenticatedContextMenuProbe.bubbled = true
      }
    }, { once: true })
  })
}

async function contextMenuProbe(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __authenticatedContextMenuProbe?: ContextMenuProbe }
  ).__authenticatedContextMenuProbe)
}

async function rightClickDisposition(
  page: Page,
  target: Locator,
  expectedDefaultPrevented: boolean,
) {
  await observeNextContextMenu(page)
  await target.click({ button: "right" })
  await expect.poll(() => contextMenuProbe(page)).toEqual({
    defaultPrevented: expectedDefaultPrevented,
    bubbled: true,
  })
}

async function installOrdinaryProbe(page: Page) {
  await page.locator("body").evaluate(() => {
    document.querySelector("[data-authenticated-context-menu-probe]")?.remove()
    const probe = document.createElement("div")
    probe.setAttribute("data-authenticated-context-menu-probe", "")
    Object.assign(probe.style, {
      position: "fixed",
      top: "8px",
      right: "8px",
      width: "32px",
      height: "32px",
      zIndex: "2147483646",
      pointerEvents: "auto",
    })
    document.body.appendChild(probe)
  })
  return page.locator("[data-authenticated-context-menu-probe]")
}

async function dispatchSecondaryPointer(
  target: Locator,
  type: "pointerdown" | "pointerup" | "pointercancel",
  pointerId: number,
) {
  await target.dispatchEvent(type, {
    bubbles: true,
    button: 2,
    buttons: type === "pointerdown" ? 2 : 0,
    clientX: 20,
    clientY: 20,
    pointerId,
    pointerType: "mouse",
  })
}

function visibleContextMenu(page: Page) {
  return page.locator('[data-slot="context-menu-content"][data-open]')
}

async function dismissContextMenu(page: Page) {
  await page.keyboard.press("Escape")
  await expect(visibleContextMenu(page)).toHaveCount(0)
  await page.waitForTimeout(150)
}

test("Community owns ordinary context menus and preserves native exceptions", async ({ asUser }) => {
  const serverId = await seedServer("alice", `Context policy ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "context-policy")
  const messageId = await seedMessage("alice", channelId, `Context policy row ${Date.now()}`)
  const { page } = await asUser("alice")
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const row = page.getByTestId(tid.message(messageId))
  await row.hover()
  const trigger = row.locator('[data-slot="context-menu-trigger"]')
  await expect(trigger).toHaveCount(1)
  await expect(composerEditable(page)).toBeVisible()
  await page.waitForTimeout(250)
  const writes: string[] = []
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  })

  for (const sample of [
    { width: 1280, height: 720, colorScheme: "light" as const },
    { width: 639, height: 720, colorScheme: "dark" as const },
    { width: 640, height: 720, colorScheme: "light" as const },
    { width: 390, height: 720, colorScheme: "dark" as const },
    { width: 320, height: 640, colorScheme: "light" as const },
  ]) {
    await page.setViewportSize({ width: sample.width, height: sample.height })
    await page.emulateMedia({ colorScheme: sample.colorScheme })
    await rightClickDisposition(page, await installOrdinaryProbe(page), true)
  }

  await rightClickDisposition(page, composerEditable(page), false)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.emulateMedia({ colorScheme: "light" })
  await row.hover()
  await expect(trigger).toHaveCount(1)

  await trigger.evaluate((element) => element.setAttribute("data-native-context-menu", "true"))
  await rightClickDisposition(page, trigger, false)
  await expect(visibleContextMenu(page)).toHaveCount(0)

  await trigger.evaluate((element) => element.setAttribute("data-native-context-menu", "true"))
  await dispatchSecondaryPointer(trigger, "pointerdown", 31)
  await page.waitForTimeout(50)
  await dispatchSecondaryPointer(trigger, "pointerup", 31)
  await page.waitForTimeout(50)
  await trigger.evaluate((element) => element.removeAttribute("data-native-context-menu"))
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await rightClickDisposition(page, trigger, true)
  await expect(visibleContextMenu(page)).toBeVisible()
  await dismissContextMenu(page)

  await trigger.evaluate((element) => {
    element.setAttribute("tabindex", "0")
    const htmlElement = element as HTMLElement
    htmlElement.focus()
  })
  await page.keyboard.press("Shift+F10")
  await expect(visibleContextMenu(page)).toBeVisible()
  await dismissContextMenu(page)
  expect(writes).toEqual([])
})

test("workspace menus keep custom behavior while editors and escapes stay native", async ({ asUser }) => {
  const { context, page } = await asUser("alice", { viewport: { width: 1280, height: 720 } })
  const suffix = Date.now().toString(36)
  const slug = `context-policy-${suffix}`
  const workspaceResponse = await context.request.post("/api/workspaces", {
    data: { name: `Context Policy ${suffix}`, slug },
  })
  expect(workspaceResponse.status()).toBe(201)
  const workspace = await workspaceResponse.json() as { id: string; slug: string }
  const onboardedResponse = await context.request.post(`/api/workspaces/${workspace.id}/onboarded`)
  expect(onboardedResponse.status()).toBe(200)

  const titles = [`Context alpha ${suffix}`, `Context beta ${suffix}`]
  for (const title of titles) {
    const issueResponse = await context.request.post(`/api/issues?workspace_id=${workspace.id}`, {
      data: { title, description: "" },
    })
    expect(issueResponse.status()).toBe(201)
  }

  const writes: string[] = []
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  })
  await page.goto(`/w/${workspace.slug}/issues`, { waitUntil: "commit" })
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible({ timeout: 20_000 })
  const first = page.locator('[data-slot="context-menu-trigger"]').filter({ hasText: titles[0] }).first()
  const second = page.locator('[data-slot="context-menu-trigger"]').filter({ hasText: titles[1] }).first()
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  await rightClickDisposition(page, first, true)
  await expect(visibleContextMenu(page).getByRole("menuitem", { name: "Delete" })).toBeVisible()
  await dismissContextMenu(page)

  await first.evaluate((element) => element.setAttribute("data-native-context-menu", "true"))
  await rightClickDisposition(page, first, false)
  await expect(visibleContextMenu(page)).toHaveCount(0)

  await first.evaluate((element) => element.setAttribute("data-native-context-menu", "true"))
  await dispatchSecondaryPointer(first, "pointerdown", 41)
  await page.waitForTimeout(50)
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await page.waitForTimeout(50)
  await first.evaluate((element) => element.removeAttribute("data-native-context-menu"))
  await rightClickDisposition(page, first, true)
  await expect(visibleContextMenu(page).getByRole("menuitem", { name: "Delete" })).toBeVisible()
  await dismissContextMenu(page)

  await first.evaluate((element) => element.setAttribute("data-native-context-menu", "true"))
  await dispatchSecondaryPointer(first, "pointerdown", 51)
  await page.waitForTimeout(50)
  await first.evaluate((element) => element.removeAttribute("data-native-context-menu"))
  await rightClickDisposition(page, second, true)
  await expect(visibleContextMenu(page).getByRole("menuitem", { name: "Delete" })).toBeVisible()
  await dismissContextMenu(page)
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await page.waitForTimeout(50)

  await rightClickDisposition(page, first, true)
  await expect(visibleContextMenu(page).getByRole("menuitem", { name: "Delete" })).toBeVisible()
  await dismissContextMenu(page)

  await first.focus()
  await page.keyboard.press("Shift+F10")
  await expect(visibleContextMenu(page).getByRole("menuitem", { name: "Delete" })).toBeVisible()
  await dismissContextMenu(page)

  await page.getByRole("button", { name: "New issue" }).click()
  const titleEditor = page.getByPlaceholder("New issue")
  await expect(titleEditor).toBeVisible()
  await rightClickDisposition(page, titleEditor, false)
  await page.keyboard.press("Escape")
  expect(writes).toEqual([])
})

test("public, auth, and invite routes remain browser owned", async ({ page, asUser }) => {
  for (const route of ["/", "/sign-in", "/c/invite/not-a-real-token"]) {
    await page.goto(route, { waitUntil: "commit" })
    await expect(page.locator("body")).toBeVisible()
    await rightClickDisposition(page, await installOrdinaryProbe(page), false)
  }

  const authenticated = await asUser("alice")
  await authenticated.page.goto("/invite/not-a-real-token", { waitUntil: "commit" })
  await expect(authenticated.page.locator("body")).toBeVisible()
  await rightClickDisposition(
    authenticated.page,
    await installOrdinaryProbe(authenticated.page),
    false,
  )
})
