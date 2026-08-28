import { type Page, type WebSocket, expect } from "@playwright/test"
import { tid } from "./testids"

export async function gotoAfterUserWsAuth(page: Page, url: string): Promise<void> {
  const frameHandlers = new Map<WebSocket, (event: { payload: string | Buffer }) => void>()
  let cleanup = () => {}
  const authenticated = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("user WebSocket did not authenticate")), 20_000)
    const onWebSocket = (socket: WebSocket) => {
      const onFrame = (event: { payload: string | Buffer }) => {
        try {
          const message = JSON.parse(event.payload.toString()) as { type?: string }
          if (message.type !== "auth.ok") return
          cleanup()
          resolve()
        } catch {}
      }
      frameHandlers.set(socket, onFrame)
      socket.on("framereceived", onFrame)
    }
    cleanup = () => {
      clearTimeout(timer)
      page.off("websocket", onWebSocket)
      for (const [socket, handler] of frameHandlers) socket.off("framereceived", handler)
    }
    page.on("websocket", onWebSocket)
  })

  try {
    await Promise.all([page.goto(url, { waitUntil: "commit" }), authenticated])
  } finally {
    cleanup()
  }
}

// Reusable UI action helpers built on the canonical testids. Journeys compose
// these so the real user path (click → type → assert) stays readable and the
// selectors live in one place.
//
// NOTE: every `page.waitForURL(...)` in this suite passes `waitUntil: "commit"`.
// `next dev` compiles routes lazily on first hit, so the initial page's `load`
// event can lag many seconds behind the URL change while a chunk compiles — the
// default `waitUntil: "load"` then times out even though navigation already
// happened (the CI symptom: "navigated to <correct url>" then a 20s timeout).
// Specs assert on real DOM right after (which auto-waits), so `commit` is the
// correct, non-flaky signal.

// Create a server through the rail. `openViaAddButton` clicks the "+" (the
// empty-list auto-dialog covers the first-server case separately). The product
// first navigates to the server root; if its default-channel redirect lags,
// select the rendered default channel explicitly before returning.
export async function createServer(page: Page, name: string, opts?: { autoDialog?: boolean }): Promise<string> {
  if (!opts?.autoDialog) {
    await page.getByTestId(tid.serverAdd).click()
  }
  await page.getByLabel("Server name").fill(name)
  await page.getByTestId(tid.createServerSubmit).click()

  await page.waitForURL(/\/c\/channels\/[^/]+(?:\/[^/]+)?$/, {
    timeout: 45_000,
    waitUntil: "commit",
  })
  const m = page.url().match(/\/c\/channels\/([^/]+)/)
  if (!m) throw new Error(`createServer: no serverId in URL ${page.url()}`)
  const serverId = m[1]
  if (new URL(page.url()).pathname === `/c/channels/${serverId}`) {
    const channelRowPrefix = tid.channelRow("")
    await page.locator(`[data-testid^="${channelRowPrefix}"]`).first().click()
    await page.waitForURL(new RegExp(`/c/channels/${serverId}/[^/]+$`), {
      timeout: 45_000,
      waitUntil: "commit",
    })
  }
  return serverId
}

// Create a channel inside the named category via its "+" button. Returns the
// new channel id parsed from the URL after auto-navigation, or resolves once
// the channel row appears in the sidebar.
export async function createChannel(page: Page, categoryName: string, channelName: string): Promise<void> {
  await page.getByRole("button", { name: `Create channel in ${categoryName}` }).click()
  await page.getByPlaceholder("new-channel").fill(channelName)
  await page.getByTestId(tid.createChannelSubmit).click()
  // The dialog closes; the new channel row renders in the sidebar.
  await expect(page.getByText(channelName, { exact: false }).first()).toBeVisible()
}

export async function openServer(page: Page, serverId: string): Promise<void> {
  await page.getByTestId(tid.serverIcon(serverId)).click()
  await page.waitForURL(new RegExp(`/c/channels/${serverId}/`), { timeout: 20_000, waitUntil: "commit" })
}

export async function openChannel(page: Page, channelId: string): Promise<void> {
  await page.getByTestId(tid.channelRow(channelId)).click()
  await page.waitForURL(new RegExp(`/${channelId}(\\?|$)`), { timeout: 20_000, waitUntil: "commit" })
}

// The ProseMirror contenteditable inside the composer wrapper. Clicking the
// wrapper's testid alone doesn't always land the caret in the editable, so
// target the contenteditable directly for typing.
export function composerEditable(page: Page) {
  return page.getByTestId(tid.composerInput).locator("[contenteditable='true']")
}

// Type into the TipTap composer and submit through the control for the current
// breakpoint: the explicit send button below 640px, or Enter on desktop.
export async function sendMessage(page: Page, text: string): Promise<void> {
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially(text)
  if ((page.viewportSize()?.width ?? 640) < 640) {
    const sendButton = page.getByTestId(tid.composerSend)
    await expect(sendButton).toBeVisible()
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    return
  }
  await page.keyboard.press("Enter")
}

// Assert a message with the given text is visible in the list.
export async function expectMessageVisible(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
}
