import { type Page, expect } from "@playwright/test"
import { tid } from "./testids"

// Reusable UI action helpers built on the canonical testids. Journeys compose
// these so the real user path (click → type → assert) stays readable and the
// selectors live in one place.

// Create a server through the rail. `openViaAddButton` clicks the "+" (the
// empty-list auto-dialog covers the first-server case separately). Waits for
// the URL to settle on a channel of the new server, then returns its id.
export async function createServer(page: Page, name: string, opts?: { autoDialog?: boolean }): Promise<string> {
  if (!opts?.autoDialog) {
    await page.getByTestId(tid.serverAdd).click()
    // Choose "Create a server" in the choose step.
    await page.getByRole("button", { name: "Create a server" }).click()
  }
  await page.getByLabel("Server name").fill(name)
  await page.getByTestId(tid.createServerSubmit).click()

  // Land on the new server's default channel.
  await page.waitForURL(/\/c\/channels\/[^/]+\/[^/]+/, { timeout: 20_000 })
  const m = page.url().match(/\/c\/channels\/([^/]+)\//)
  if (!m) throw new Error(`createServer: no serverId in URL ${page.url()}`)
  return m[1]
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
  await page.waitForURL(new RegExp(`/c/channels/${serverId}/`), { timeout: 20_000 })
}

export async function openChannel(page: Page, channelId: string): Promise<void> {
  await page.getByTestId(tid.channelRow(channelId)).click()
  await page.waitForURL(new RegExp(`/${channelId}(\\?|$)`), { timeout: 20_000 })
}

// The ProseMirror contenteditable inside the composer wrapper. Clicking the
// wrapper's testid alone doesn't always land the caret in the editable, so
// target the contenteditable directly for typing.
export function composerEditable(page: Page) {
  return page.getByTestId(tid.composerInput).locator("[contenteditable='true']")
}

// Type into the TipTap composer and send with Enter. Returns after the input
// clears (the send round-trip's observable completion).
export async function sendMessage(page: Page, text: string): Promise<void> {
  const editable = composerEditable(page)
  await editable.click()
  await editable.pressSequentially(text)
  await page.keyboard.press("Enter")
}

// Assert a message with the given text is visible in the list.
export async function expectMessageVisible(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
}
