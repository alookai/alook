import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth, sendMessage } from "./_fixtures/actions"
import { communityFrameEvents, proxyCommunityWebSockets } from "./_fixtures/community-ws-proxy"
import { tid } from "./_fixtures/testids"
import { seedChannel, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { WEB_URL } from "./_setup/paths"

type BodySample = {
  scrollTop: number
  bodies: Array<{ id: string; top: number; bottom: number; height: number }>
}

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

  const { page, context } = await asUser("alice")
  const proxy = await proxyCommunityWebSockets(context)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  await page.waitForURL(new RegExp(channelId), { timeout: 20_000, waitUntil: "commit" })
  const divider = page.getByTestId(tid.newDivider)
  await expect(divider).toBeVisible({ timeout: 30_000 })

  const scroller = page.getByTestId(tid.messageScroller)
  await expect(scroller).toHaveCount(1)
  const box = await scroller.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

  const recorder = await scroller.evaluateHandle((element) => {
    const root = element as HTMLElement
    const samples: BodySample[] = []
    const sample = () => {
      const viewport = root.getBoundingClientRect()
      const bodies = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]"))
        .flatMap((body) => {
          const rect = body.getBoundingClientRect()
          const id = body.dataset.msgId
          return id && rect.height > 0 && rect.width > 0
            && rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
            ? [{ id, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top, height: rect.height }]
            : []
        })
      samples.push({ scrollTop: root.scrollTop, bodies })
    }
    let frame: number
    const onFrame = () => {
      sample()
      frame = requestAnimationFrame(onFrame)
    }
    sample()
    root.addEventListener("scroll", sample, { passive: true })
    frame = requestAnimationFrame(onFrame)
    return {
      sample,
      finish: () => {
        cancelAnimationFrame(frame)
        root.removeEventListener("scroll", sample)
        sample()
        return samples
      },
    }
  })

  let bodySamples: BodySample[] = []
  let liveMessageId = ""
  try {
    const liveAppend = (async () => {
      await page.waitForTimeout(250) // inject the append during the upward-scroll gesture
      return seedMessage("bob", channelId, `live during upward scroll ${Date.now()}`)
    })()
    for (let index = 0; index < 60; index++) {
      await page.mouse.wheel(0, -24)
      await page.waitForTimeout(24) // fixed wheel-event cadence under test
      await recorder.evaluate((recording) => recording.sample())
    }
    liveMessageId = await liveAppend
    await page.waitForTimeout(250) // post-append scroll-correction exclusion window
  } finally {
    bodySamples = await recorder.evaluate((recording) => recording.finish())
    await recorder.dispose()
  }

  await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.id === liveMessageId,
  )).length).toBe(1)
  expect(bodySamples.length).toBeGreaterThan(1)
  let upwardProgress = 0
  for (let index = 1; index < bodySamples.length; index++) {
    const before = bodySamples[index - 1]!
    const after = bodySamples[index]!
    const common = before.bodies.flatMap((body) => {
      const next = after.bodies.find((candidate) => candidate.id === body.id)
      return next ? [{ id: body.id, delta: next.top - body.top }] : []
    })
    const diagnostic = JSON.stringify({ index, before, after, common })
    expect(common.length, diagnostic).toBeGreaterThan(0)
    for (const body of common) {
      expect(body.delta, diagnostic).toBeGreaterThanOrEqual(-4)
    }
    const deltas = common.map((body) => body.delta).sort((a, b) => a - b)
    upwardProgress += deltas[Math.floor(deltas.length / 2)]!
  }
  expect(upwardProgress).toBeGreaterThan(600)
})

test("New reading near the tail survives peer and remote-self messages until the current composer submits", async ({ asUser }) => {
  test.setTimeout(120_000)
  const serverId = await seedServer("alice", `NEW near tail ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "new-near-tail")
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  let readThroughId = ""
  for (let index = 0; index < 18; index++) readThroughId = await seedMessage("alice", channelId, `read ${index}`)
  const read = await fetch(`${WEB_URL}/api/community/channels/${channelId}/read`, {
    method: "PUT",
    headers: { Cookie: sessionCookie("alice"), "Content-Type": "application/json", Origin: WEB_URL },
    body: JSON.stringify({ lastReadMessageId: readThroughId }),
  })
  expect(read.status).toBe(200)
  for (let index = 0; index < 5; index++) await seedMessage(index % 2 ? "bob" : "carol", channelId, `unread ${index}`)
  const { page, context } = await asUser("alice")
  await page.setViewportSize({ width: 1280, height: 800 })
  const proxy = await proxyCommunityWebSockets(context)
  await gotoAfterUserWsAuth(page, `/c/channels/${serverId}/${channelId}`)
  const scroller = page.getByTestId(tid.messageScroller)
  const divider = page.getByTestId(tid.newDivider)
  await expect(divider).toBeVisible()
  await expect(scroller.locator('[data-message-list-content]')).toHaveAttribute("data-read-position-ready", "true")
  await scroller.evaluate(element => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 20
    element.dispatchEvent(new Event("scroll"))
  })
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBe(20)
  await expect(divider).toBeVisible()
  const before = await divider.evaluate(element => element.getBoundingClientRect().top)
  for (const author of ["bob", "alice"] as const) {
    const id = await seedMessage(author, channelId, `remote ${author} near New ${Date.now()}`)
    await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
      event.type === "community:message.create" && event.channelId === channelId && event.message?.id === id,
    )).length).toBe(1)
    await expect(divider).toBeVisible()
    await page.waitForTimeout(250)
    expect(Math.abs(await divider.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1)
  }
  const content = `local composer near New ${Date.now()}`
  await sendMessage(page, content)
  await expect(page.getByText(content, { exact: true })).toHaveCount(1)
  await expect.poll(() => proxy.frames.filter(frame => communityFrameEvents(frame).some(event =>
    event.type === "community:message.create" && event.channelId === channelId && event.message?.content === content,
  )).length).toBe(1)
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
})
