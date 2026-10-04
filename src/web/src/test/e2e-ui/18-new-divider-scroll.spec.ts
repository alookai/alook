import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
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

  const { page } = await asUser("alice")
  await page.goto(`/c/channels/${serverId}/${channelId}`)
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
    await liveAppend
    await page.waitForTimeout(250) // post-append scroll-correction exclusion window
  } finally {
    bodySamples = await recorder.evaluate((recording) => recording.finish())
    await recorder.dispose()
  }

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
