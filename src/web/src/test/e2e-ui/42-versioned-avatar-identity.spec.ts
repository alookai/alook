import type { Page } from "@playwright/test"
import {
  expect,
  test,
  userId,
  userName,
} from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import {
  seedChannel,
  seedDm,
  seedDmMessage,
  seedFriendship,
  seedJoinServer,
  seedMessage,
  seedServer,
} from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import {
  communityFrameEvents,
  proxyCommunityWebSockets,
  type CapturedCommunityFrame,
} from "./_fixtures/community-ws-proxy"

type AvatarUpload = {
  status: number
  url: string
  avatarVersion: number
}

const hideDevelopmentOverlays = "nextjs-portal, .tsqd-parent-container { display: none !important; }"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function identityEvents(frames: CapturedCommunityFrame[], subjectId: string) {
  return frames.flatMap(communityFrameEvents).filter((event) => (
    event.type === "community:identity.update"
    && event.userId === subjectId
  ))
}

async function uploadSolidAvatar(page: Page, color: string): Promise<AvatarUpload> {
  return page.evaluate(async (fill) => {
    const canvas = document.createElement("canvas")
    canvas.width = 48
    canvas.height = 48
    const context = canvas.getContext("2d")!
    context.fillStyle = fill
    context.fillRect(0, 0, 48, 48)
    context.strokeStyle = "#ffffff"
    context.lineWidth = 6
    context.beginPath()
    context.moveTo(8, 40)
    context.lineTo(40, 8)
    context.stroke()
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error("PNG encoding failed")),
      "image/png",
    ))
    const form = new FormData()
    form.append("file", new File([blob], "avatar.png", { type: "image/png" }))
    const response = await fetch("/api/community/users/me/avatar", {
      method: "POST",
      body: form,
      credentials: "include",
    })
    return {
      status: response.status,
      ...await response.json() as { url: string; avatarVersion: number },
    }
  }, color)
}

async function expectPhoto(locator: ReturnType<Page["locator"]>, url: string) {
  const photo = locator.locator(`img[src="${url}"]`).first()
  await expect(photo).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => (
    image.complete && image.naturalWidth > 0
  )), { timeout: 20_000 }).toBe(true)
}

test("versioned avatars converge across live, stale, reconnect, cold, and concurrent clients", async ({ asUser }, testInfo) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const aliceId = userId("alice")
  const serverId = await seedServer("alice", `Avatar identity ${stamp}`)
  const channelId = await seedChannel("alice", serverId, `avatar-${stamp}`)
  await seedJoinServer("alice", "bob", serverId)
  const messageId = await seedMessage("alice", channelId, `Avatar source ${stamp}`)
  const dmId = await seedDm("alice", userId("bob"))
  await seedDmMessage("alice", dmId, `Avatar DM ${stamp}`)
  await seedFriendship("alice", "bob", userId("bob"))

  const uploader = await asUser("alice")
  const sameAccount = await asUser("alice")
  const observer = await asUser("bob")
  // Dave is reserved for this final audience-isolation check. Carol already
  // shares a server with Alice after earlier serial specs, so she is an
  // authorized identity observer in a full-shard run even though this spec
  // does not create that relationship itself.
  const stranger = await asUser("dave")
  await sameAccount.page.setViewportSize({ width: 390, height: 844 })
  await observer.page.setViewportSize({ width: 1280, height: 900 })

  let holdNextAliceIdentity = false
  const uploaderWs = await proxyCommunityWebSockets(uploader.context)
  const sameAccountWs = await proxyCommunityWebSockets(sameAccount.context)
  const observerWs = await proxyCommunityWebSockets(observer.context, {
    decide: (frame) => {
      if (
        holdNextAliceIdentity
        && identityEvents([frame], aliceId).length > 0
      ) {
        holdNextAliceIdentity = false
        return "hold"
      }
      return "forward"
    },
  })
  const strangerWs = await proxyCommunityWebSockets(stranger.context)

  await gotoAfterUserWsAuth(uploader.page, "/c/me")
  await gotoAfterUserWsAuth(sameAccount.page, "/c/me")
  await gotoAfterUserWsAuth(observer.page, `/c/channels/${serverId}/${channelId}`)
  await gotoAfterUserWsAuth(stranger.page, "/c/me")
  const message = observer.page.locator(`[data-msg-id="${messageId}"]`)
  await expect(message).toBeVisible({ timeout: 20_000 })

  const profileGate = deferred()
  const profileStarted = deferred()
  const profilePattern = `**/api/community/users/${aliceId}/profile`
  await observer.page.route(profilePattern, async (route) => {
    const staleResponse = await route.fetch()
    profileStarted.resolve()
    await profileGate.promise
    await route.fulfill({ response: staleResponse })
  })
  await message.getByRole("button", { name: userName("alice"), exact: true }).click()
  await profileStarted.promise

  holdNextAliceIdentity = true
  const first = await uploadSolidAvatar(uploader.page, "#e5484d")
  expect(first.status).toBe(200)
  expect(first.url).toBe(`/api/community/users/${aliceId}/avatar?v=${first.avatarVersion}`)
  await expect.poll(() => observerWs.heldCount(), { timeout: 20_000 }).toBe(1)

  const second = await uploadSolidAvatar(uploader.page, "#3b82f6")
  expect(second.status).toBe(200)
  expect(second.avatarVersion).toBe(first.avatarVersion + 1)
  await expect.poll(() => identityEvents(observerWs.frames, aliceId).some(
    (event) => event.avatarVersion === second.avatarVersion,
  ), { timeout: 20_000 }).toBe(true)

  await expectPhoto(message, second.url)
  await expectPhoto(sameAccount.page.locator("body"), second.url)
  profileGate.resolve()
  await expectPhoto(observer.page.getByTestId(tid.profileCard), second.url)
  await observer.page.unroute(profilePattern)

  expect(observerWs.releaseHeld((frame) => identityEvents([frame], aliceId).some(
    (event) => event.avatarVersion === first.avatarVersion,
  ))).toBe(1)
  await observer.page.waitForTimeout(250)
  await expectPhoto(message, second.url)
  await expectPhoto(observer.page.getByTestId(tid.profileCard), second.url)

  await observer.page.getByTestId(tid.profileCard).press("Escape")
  await observer.page.getByRole("button", { name: /member/i }).first().click()
  await expectPhoto(observer.page.getByTestId(tid.memberRow(aliceId)), second.url)
  await observer.page.addStyleTag({ content: hideDevelopmentOverlays })
  await observer.page.screenshot({
    path: testInfo.outputPath("versioned-avatar-desktop-1280x900.png"),
    animations: "disabled",
  })

  await gotoAfterUserWsAuth(observer.page, "/c/me")
  await expectPhoto(observer.page.getByTestId(tid.dmRow(dmId)), second.url)
  await gotoAfterUserWsAuth(observer.page, "/c/me/friends")
  const friendRow = observer.page.getByText(userName("alice"), { exact: true })
    .locator("xpath=ancestor::button[1]")
  await expectPhoto(friendRow, second.url)

  await observer.context.setOffline(true)
  await observerWs.disconnect()
  const third = await uploadSolidAvatar(uploader.page, "#22c55e")
  expect(third.status).toBe(200)
  expect(third.avatarVersion).toBe(second.avatarVersion + 1)
  await observer.context.setOffline(false)
  await expectPhoto(friendRow, third.url)

  const cold = await asUser("bob")
  await cold.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(cold.page, `/c/channels/${serverId}/${channelId}`)
  await expectPhoto(cold.page.locator(`[data-msg-id="${messageId}"]`), third.url)

  const [concurrentA, concurrentB] = await Promise.all([
    uploadSolidAvatar(uploader.page, "#f59e0b"),
    uploadSolidAvatar(sameAccount.page, "#a855f7"),
  ])
  expect(concurrentA.status).toBe(200)
  expect(concurrentB.status).toBe(200)
  const winner = concurrentA.avatarVersion > concurrentB.avatarVersion
    ? concurrentA
    : concurrentB
  expect(Math.abs(concurrentA.avatarVersion - concurrentB.avatarVersion)).toBe(1)

  await expectPhoto(uploader.page.locator("body"), winner.url)
  await expectPhoto(sameAccount.page.locator("body"), winner.url)
  await expectPhoto(cold.page.locator(`[data-msg-id="${messageId}"]`), winner.url)
  const selfProfile = await uploader.page.request.get("/api/community/users/me/profile")
  expect(selfProfile.status()).toBe(200)
  expect(await selfProfile.json()).toMatchObject({
    id: aliceId,
    avatar: winner.url,
    avatarVersion: winner.avatarVersion,
  })
  const stableRead = await uploader.page.request.get(`/api/community/users/${aliceId}/avatar`, {
    maxRedirects: 0,
  })
  expect(stableRead.status()).toBe(307)
  expect(stableRead.headers().location).toBe(winner.url)
  const immutableRead = await uploader.page.request.get(winner.url)
  expect(immutableRead.status()).toBe(200)
  expect(immutableRead.headers()["cache-control"]).toBe("private, max-age=31536000, immutable")

  await expect.poll(() => identityEvents(uploaderWs.frames, aliceId).some(
    (event) => event.avatarVersion === winner.avatarVersion,
  ), { timeout: 20_000 }).toBe(true)
  await expect.poll(() => identityEvents(sameAccountWs.frames, aliceId).some(
    (event) => event.avatarVersion === winner.avatarVersion,
  ), { timeout: 20_000 }).toBe(true)
  await expect.poll(() => identityEvents(observerWs.frames, aliceId).length, {
    timeout: 20_000,
  }).toBeGreaterThanOrEqual(3)
  expect(identityEvents(strangerWs.frames, aliceId)).toEqual([])

  await gotoAfterUserWsAuth(sameAccount.page, "/c/me")
  await expectPhoto(sameAccount.page.locator("body"), winner.url)
  await sameAccount.page.addStyleTag({ content: hideDevelopmentOverlays })
  await sameAccount.page.getByTestId(tid.userSettingsOpen).click()
  await expect(sameAccount.page.getByTestId(tid.settingsShell)).toBeVisible()
  await expectPhoto(sameAccount.page.getByTestId(tid.settingsShell), winner.url)
  await sameAccount.page.screenshot({
    path: testInfo.outputPath("versioned-avatar-mobile-390x844.png"),
    animations: "disabled",
  })
})
