import type { BrowserPage } from "./types"

const GOOGLE_MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isValidMeetUrl(url: string): boolean {
  return GOOGLE_MEET_URL_RE.test(url)
}

async function dismissDialogs(page: BrowserPage): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const dialogBtn = await page.$('[role="dialog"] button, [role="alertdialog"] button, [role="alert"] button')
      if (dialogBtn) {
        await dialogBtn.click()
        await delay(300)
        continue
      }
    } catch { /* no dialog */ }
    break
  }
}

async function detectBlocked(page: BrowserPage): Promise<void> {
  const blocked = await page.evaluate(() => {
    const text = document.body?.innerText || ""
    if (text.includes("can't join") || text.includes("unable to join") || text.includes("无法加入")) {
      return text.slice(0, 200)
    }
    return null
  })
  if (blocked) {
    throw new Error(`Blocked from joining: ${blocked}`)
  }
}

export async function joinMeeting(page: BrowserPage, meetingUrl: string, botName: string): Promise<void> {
  await page.goto(meetingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await delay(2000)

  await detectBlocked(page)
  await dismissDialogs(page)

  // Type bot name (English locale: "Your name")
  try {
    const nameInput = await page.waitForSelector(
      'input[aria-label="Your name"]',
      { timeout: 10_000 },
    )
    if (nameInput) {
      await nameInput.click({ clickCount: 3 })
      await nameInput.type(botName)
    }
  } catch {
    // Name input may not appear if already signed in
  }

  // Mute mic and camera — try both pre-join (data-is-muted) and in-meeting (aria-label) patterns
  await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const muted = btn.getAttribute('data-is-muted');
      // Pre-join: buttons have data-is-muted attribute
      if (muted === 'false' && (label.includes('microphone') || label.includes('camera'))) {
        (btn as HTMLElement).click();
        continue;
      }
      // Also match "Turn off microphone" / "Turn off camera" buttons
      if (label.startsWith('turn off') && (label.includes('microphone') || label.includes('camera'))) {
        (btn as HTMLElement).click();
      }
    }
  })

  // "Ask to join" / "Join now" — find by text content, language-independent via evaluate
  const joined = await page.evaluate(() => {
    const deadline = Date.now() + 15_000;
    return new Promise((resolve) => {
      const check = () => {
        const btns = document.querySelectorAll('button:not([disabled])');
        for (const btn of btns) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('join') || text.includes('加入')) {
            // Skip "other ways to join" type buttons
            if (text.includes('other') || text.includes('其他')) continue;
            (btn as HTMLElement).click();
            return resolve(true);
          }
        }
        if (Date.now() < deadline) setTimeout(check, 500);
        else resolve(false);
      };
      check();
    });
  })
  if (!joined) throw new Error("Join button not found or remained disabled")

  await delay(3000)
  await detectBlocked(page)
}

export async function enableCaptions(page: BrowserPage): Promise<void> {
  // Click the captions button to open the transcript side panel.
  // The button contains a "closed_caption" icon text — find it by that.
  const clicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const text = (btn.textContent || '').toLowerCase();
      if (label.includes('caption') || label.includes('subtitle') || label.includes('字幕') ||
          text.includes('closed_caption')) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  })
  if (clicked) {
    await delay(2000)
  }
}

export async function waitForMeetingReady(page: BrowserPage, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || ""
      if (text.includes("Please wait") || text.includes("请等待")) return "waiting"
      if (text.includes("can't join") || text.includes("无法加入")) return "blocked"
      // In-meeting: participants panel or caption button visible
      const inCall = document.querySelector('button[aria-label*="Leave call" i], button[aria-label="退出通话"]')
      const waiting = document.querySelector('[aria-label*="wait" i]')
      if (inCall && !waiting) return "ready"
      return "loading"
    })
    if (state === "ready") return
    if (state === "blocked") throw new Error("Blocked from joining meeting")
    await delay(2000)
  }
  throw new Error("Timed out waiting to be admitted to meeting")
}

export async function isMeetingActive(page: BrowserPage): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const leaveBtn = document.querySelector('button[aria-label="Leave call" i], button[aria-label*="hang up" i]')
      if (!leaveBtn) return false

      // Check participant count from the badge in the top-right corner
      // The badge shows "2", "3" etc. — look for small elements containing just a number
      // near the participant/people button area
      const allElements = document.querySelectorAll('[aria-label*="participant" i], [aria-label*="people" i]')
      for (const el of allElements) {
        const nums = el.textContent?.match(/\d+/)
        if (nums) {
          const count = parseInt(nums[0], 10)
          if (!isNaN(count) && count <= 1) return false
        }
      }

      // Also check full page text for "only one" messages (may appear briefly)
      const text = document.body?.innerText || ""
      if (text.includes("You're the only one") || text.includes("No one else is here") ||
          text.includes("只有你一个人") || text.includes("没有其他人")) {
        return false
      }

      return true
    })
  } catch {
    return false
  }
}

export async function leaveMeeting(page: BrowserPage): Promise<void> {
  try {
    const leaveButton = await page.$('button[aria-label="Leave call" i], button[aria-label*="hang up" i]')
    if (leaveButton) {
      await leaveButton.click()
      await delay(2000)
    }
  } catch {
    // Best-effort leave
  }
}
