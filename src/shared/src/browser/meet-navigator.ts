import type { BrowserPage } from "./types"

const GOOGLE_MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isValidMeetUrl(url: string): boolean {
  return GOOGLE_MEET_URL_RE.test(url)
}

export async function joinMeeting(page: BrowserPage, meetingUrl: string, botName: string): Promise<void> {
  await page.goto(meetingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })

  try {
    const nameInput = await page.waitForSelector('input[aria-label="Your name"]', { timeout: 10_000 })
    if (nameInput) {
      await nameInput.click({ clickCount: 3 })
      await nameInput.type(botName)
    }
  } catch {
    // Name input may not appear if already signed in
  }

  try {
    const micButton = await page.$('[data-is-muted="false"][aria-label*="microphone" i]')
    if (micButton) await micButton.click()
  } catch { /* mic may already be off */ }

  try {
    const camButton = await page.$('[data-is-muted="false"][aria-label*="camera" i]')
    if (camButton) await camButton.click()
  } catch { /* camera may already be off */ }

  const joinButton = await page.waitForSelector(
    'button[data-idom-class*="join"], [jsname="Qx7uuf"]',
    { timeout: 15_000 },
  )
  if (joinButton) {
    await joinButton.click()
  }

  await delay(3000)
}

export async function enableCaptions(page: BrowserPage): Promise<void> {
  try {
    const ccButton = await page.waitForSelector(
      'button[aria-label*="captions" i], button[aria-label*="subtitle" i]',
      { timeout: 10_000 },
    )
    if (ccButton) {
      await ccButton.click()
      await delay(1000)
    }
  } catch {
    // Captions button may not be available immediately
  }
}

export async function isMeetingActive(page: BrowserPage): Promise<boolean> {
  try {
    const endCallButton = await page.$('[aria-label*="Leave call" i], [aria-label*="hang up" i]')
    return endCallButton !== null
  } catch {
    return false
  }
}

export async function leaveMeeting(page: BrowserPage): Promise<void> {
  try {
    const leaveButton = await page.$('[aria-label*="Leave call" i], [aria-label*="hang up" i]')
    if (leaveButton) {
      await leaveButton.click()
      await delay(2000)
    }
  } catch {
    // Best-effort leave
  }
}
