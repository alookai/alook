import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { WEB_URL } from "./_setup/paths"

test("NEW divider does not fight upward scrolling while a peer message arrives", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `NEW scroll ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "new-scroll")
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)

  let readThroughId = ""
  for (let index = 0; index < 24; index++) {
    readThroughId = await seedMessage(
      "alice",
      channelId,
      `read history ${index}\n${Array.from({ length: 10 + (index % 8) }, (_, line) => `line ${line} variable width ${"x".repeat((line % 4) * 18)}`).join("\n")}`,
    )
  }

  const readResponse = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("alice"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ lastReadMessageId: readThroughId }),
  })
  expect(readResponse.status).toBe(200)

  for (let index = 0; index < 48; index++) {
    await seedMessage(
      index % 2 === 0 ? "bob" : "carol",
      channelId,
      `unread history ${index}\n${Array.from({ length: 8 + (index % 10) }, (_, line) => `line ${line} variable height ${"y".repeat((line % 5) * 15)}`).join("\n")}`,
    )
  }

  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
  await page.waitForURL(new RegExp(channelId), { timeout: 20_000, waitUntil: "commit" })
  const divider = page.getByTestId(tid.newDivider)
  await expect(divider).toBeVisible({ timeout: 30_000 })

  await divider.evaluate((element) => {
    const scroller = element.closest<HTMLElement>(".overflow-y-auto")
    if (!scroller) throw new Error("message scroller not found")
    scroller.dataset.e2eMessageScroller = "true"
  })
  const scroller = page.locator("[data-e2e-message-scroller='true']")
  await expect(scroller).toHaveCount(1)
  const box = await scroller.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

  await scroller.evaluate((element) => {
    const samples: number[] = [element.scrollTop]
    Object.defineProperty(window, "__newDividerScrollEvents", {
      configurable: true,
      value: samples,
    })
    element.addEventListener("scroll", () => samples.push(element.scrollTop), { passive: true })
  })

  const samples: number[] = [await scroller.evaluate((element) => element.scrollTop)]
  const liveAppend = (async () => {
    await page.waitForTimeout(250)
    return seedMessage("bob", channelId, `live during upward scroll ${Date.now()}`)
  })()
  for (let index = 0; index < 60; index++) {
    await page.mouse.wheel(0, -24)
    await page.waitForTimeout(24)
    samples.push(await scroller.evaluate((element) => element.scrollTop))
  }
  await liveAppend
  await page.waitForTimeout(250)
  samples.push(await scroller.evaluate((element) => element.scrollTop))
  const scrollEvents = await page.evaluate(() => (
    window as unknown as { __newDividerScrollEvents: number[] }
  ).__newDividerScrollEvents)

  const start = samples[0]!
  const end = samples.at(-1)!
  expect(end).toBeLessThan(start - 600)
  for (let index = 1; index < scrollEvents.length; index++) {
    expect(scrollEvents[index]!).toBeLessThanOrEqual(scrollEvents[index - 1]! + 4)
  }
})
