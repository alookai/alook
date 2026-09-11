import type { Page, WebSocket } from "@playwright/test"
import { expect, sessionCookie, test } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth, openServer } from "./_fixtures/actions"
import { seedChannel, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"
import type { UserKey } from "./_setup/users"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function captureServerDeletes(page: Page) {
  const frames: Array<{ type: string; serverId?: string }> = []
  const sockets = new Set<WebSocket>()
  page.on("websocket", (socket) => {
    sockets.add(socket)
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as { type: string; serverId?: string }
        if (frame.type === "community:server.delete") frames.push(frame)
      } catch {}
    })
  })
  return { frames, sockets }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function serverIds(key: UserKey): Promise<string[]> {
  const response = await fetch(`${WEB_URL}/api/community/servers`, {
    headers: { Cookie: sessionCookie(key), Origin: WEB_URL },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { servers: Array<{ id: string }> }
  return body.servers.map((server) => server.id)
}

async function seedServerRoute(
  key: UserKey,
  name: string,
): Promise<{ serverId: string; channelId: string }> {
  const serverId = await seedServer(key, name)
  const channelId = await seedChannel(key, serverId, `${name} channel`, "text")
  return { serverId, channelId }
}

async function clickDeleteServer(page: Page, serverId: string): Promise<void> {
  await page.getByTestId(tid.serverIcon(serverId)).click({ button: "right" })
  await page.getByTestId(tid.serverSettingsOpen).click()
  await expect(page.getByTestId(tid.settingsShell)).toBeVisible()
  await page.getByRole("button", { name: "Delete Server", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", {
    name: "Delete Server",
    exact: true,
  }).click()
}

async function delayDelete(page: Page, serverId: string) {
  const release = deferred<void>()
  const intercepted = deferred<void>()
  const pattern = `**/api/community/servers/${serverId}`
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue()
      return
    }
    intercepted.resolve()
    await release.promise
    await route.continue()
  })
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${serverId}`
  ))
  await clickDeleteServer(page, serverId)
  await intercepted.promise
  return {
    release: () => release.resolve(),
    response,
    cleanup: () => page.unroute(pattern),
  }
}

async function delayServerRsc(page: Page, serverId: string) {
  const release = deferred<void>()
  const intercepted = deferred<void>()
  const pattern = "**/c/channels/**"
  await page.route(pattern, async (route) => {
    const url = new URL(route.request().url())
    const targetsServer = url.pathname === `/c/channels/${serverId}`
      || url.pathname.startsWith(`/c/channels/${serverId}/`)
    if (!targetsServer || !url.searchParams.has("_rsc")) {
      await route.continue()
      return
    }
    intercepted.resolve()
    await release.promise
    await route.continue()
  })
  return {
    intercepted: intercepted.promise,
    release: () => release.resolve(),
    cleanup: () => page.unroute(pattern),
  }
}

async function installHistoryRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __serverDeleteHistoryWrites?: Array<{ method: "push" | "replace"; href: string | null }>
      __serverDeleteHistoryWrapped?: boolean
    }
    scope.__serverDeleteHistoryWrites = []
    if (scope.__serverDeleteHistoryWrapped) return
    scope.__serverDeleteHistoryWrapped = true
    const nativePush = history.pushState
    const nativeReplace = history.replaceState
    history.pushState = function (data, unused, url) {
      scope.__serverDeleteHistoryWrites?.push({
        method: "push",
        href: url === undefined || url === null ? null : String(url),
      })
      return nativePush.call(this, data, unused, url)
    }
    history.replaceState = function (data, unused, url) {
      scope.__serverDeleteHistoryWrites?.push({
        method: "replace",
        href: url === undefined || url === null ? null : String(url),
      })
      return nativeReplace.call(this, data, unused, url)
    }
  })
}

async function resetHistoryRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __serverDeleteHistoryWrites?: unknown[]
    }
    scope.__serverDeleteHistoryWrites = []
  })
}

async function divergentHistoryWrites(page: Page, expectedPathname: string) {
  return page.evaluate((expected) => {
    const scope = window as typeof window & {
      __serverDeleteHistoryWrites?: Array<{ method: "push" | "replace"; href: string | null }>
    }
    return (scope.__serverDeleteHistoryWrites ?? []).filter(({ href }) => (
      href !== null && new URL(href, location.origin).pathname !== expected
    ))
  }, expectedPathname)
}

async function expectServerLeaf(page: Page, serverId: string): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/[^/]+$`))
  return new URL(page.url()).pathname
}

test.describe.configure({ mode: "serial" })

test("deleting the only Server replaces once to Home", async ({ asUser }) => {
  const route = await seedServerRoute("dave", `delete-only-${Date.now()}`)
  const dave = await asUser("dave")
  await gotoAfterUserWsAuth(
    dave.page,
    `/c/channels/${route.serverId}/${route.channelId}`,
  )
  await installHistoryRecorder(dave.page)
  await resetHistoryRecorder(dave.page)
  const response = dave.page.waitForResponse((candidate) => (
    candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${route.serverId}`
  ))

  await clickDeleteServer(dave.page, route.serverId)

  expect((await response).status()).toBe(204)
  await expect(dave.page).toHaveURL("/c/me")
  await expect(dave.page.getByTestId(tid.serverIcon(route.serverId))).toHaveCount(0)
  expect(await divergentHistoryWrites(dave.page, "/c/me")).toEqual([])
})

for (const testCase of [
  { key: "alice" as const, name: "computed target", chooseUserRoute: (ids: string[]) => ids[0] },
  { key: "bob" as const, name: "different safe route", chooseUserRoute: (ids: string[]) => ids[1] },
]) {
  test(`a committed ${testCase.name} wins before DELETE success with no later history write`, async ({ asUser }) => {
    const stamp = Date.now()
    const survivorA = await seedServerRoute(testCase.key, `survivor-a-${stamp}`)
    const survivorB = await seedServerRoute(testCase.key, `survivor-b-${stamp}`)
    const deleted = await seedServerRoute(testCase.key, `deleted-${stamp}`)
    const page = (await asUser(testCase.key)).page
    await gotoAfterUserWsAuth(
      page,
      `/c/channels/${deleted.serverId}/${deleted.channelId}`,
    )
    await installHistoryRecorder(page)
    const survivors = (await serverIds(testCase.key)).filter((id) => id !== deleted.serverId)
    expect(survivors).toContain(survivorA.serverId)
    expect(survivors).toContain(survivorB.serverId)
    const userServerId = testCase.chooseUserRoute(survivors)
    expect(userServerId).toBeTruthy()
    const deletion = await delayDelete(page, deleted.serverId)

    await openServer(page, userServerId)
    const safePathname = await expectServerLeaf(page, userServerId)
    await resetHistoryRecorder(page)
    deletion.release()

    expect((await deletion.response).status()).toBe(204)
    await expect(page).toHaveURL(safePathname)
    await expect(page.getByText("Server deleted", { exact: true })).toBeVisible()
    expect(await divergentHistoryWrites(page, safePathname)).toEqual([])
    await deletion.cleanup()
  })
}

test("slow target RSC survives delete/list/WS convergence and lands on its remembered Channel", async ({ asUser }) => {
  const stamp = Date.now()
  const ensuredSurvivor = await seedServerRoute("carol", `slow-target-${stamp}`)
  const deleted = await seedServerRoute("carol", `slow-deleted-${stamp}`)
  const page = (await asUser("carol")).page
  await gotoAfterUserWsAuth(
    page,
    `/c/channels/${ensuredSurvivor.serverId}/${ensuredSurvivor.channelId}`,
  )
  const targetServerId = (await serverIds("carol")).find((id) => id !== deleted.serverId)
  expect(targetServerId).toBeTruthy()
  await openServer(page, targetServerId!)
  const targetPathname = await expectServerLeaf(page, targetServerId!)
  await expect(page.getByTestId(tid.composerInput)).toBeVisible()
  await openServer(page, deleted.serverId)
  const targetRsc = await delayServerRsc(page, targetServerId!)
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${deleted.serverId}`
  ))

  await clickDeleteServer(page, deleted.serverId)

  expect((await response).status()).toBe(204)
  await targetRsc.intercepted
  expect(new URL(page.url()).pathname).not.toBe("/c/me")
  targetRsc.release()
  expect(await expectServerLeaf(page, targetServerId!)).toBe(targetPathname)
  await expect(page.getByTestId(tid.serverIcon(deleted.serverId))).toHaveCount(0)
  await targetRsc.cleanup()
})

test("a newer user navigation wins while the delete target RSC is pending", async ({ asUser }) => {
  const stamp = Date.now()
  const candidateA = await seedServerRoute("dave", `queued-target-a-${stamp}`)
  const candidateB = await seedServerRoute("dave", `queued-target-b-${stamp}`)
  const deleted = await seedServerRoute("dave", `queued-deleted-${stamp}`)
  const page = (await asUser("dave")).page
  await gotoAfterUserWsAuth(
    page,
    `/c/channels/${candidateA.serverId}/${candidateA.channelId}`,
  )
  const targetServerId = (await serverIds("dave")).find((id) => id !== deleted.serverId)
  expect(targetServerId).toBeTruthy()
  const userRoute = [candidateA, candidateB].find(({ serverId }) => (
    serverId !== targetServerId
  ))
  expect(userRoute).toBeTruthy()
  await openServer(page, targetServerId!)
  await expectServerLeaf(page, targetServerId!)
  await openServer(page, deleted.serverId)
  const targetRsc = await delayServerRsc(page, targetServerId!)
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${deleted.serverId}`
  ))

  await clickDeleteServer(page, deleted.serverId)

  expect((await response).status()).toBe(204)
  await targetRsc.intercepted
  await page.getByTestId(tid.serverIcon(userRoute!.serverId)).click()
  targetRsc.release()
  await expectServerLeaf(page, userRoute!.serverId)
  await expect(page).not.toHaveURL(new RegExp(`/c/channels/${targetServerId}(?:/|$)`), {
    timeout: 2_000,
  })
  await targetRsc.cleanup()
})

test("a Back visit after terminal cleanup is an ordinary missing route", async ({ asUser }) => {
  const stamp = Date.now()
  const survivor = await seedServerRoute("alice", `terminal-survivor-${stamp}`)
  const deleted = await seedServerRoute("alice", `terminal-deleted-${stamp}`)
  const page = (await asUser("alice")).page
  await gotoAfterUserWsAuth(
    page,
    `/c/channels/${deleted.serverId}/${deleted.channelId}`,
  )
  const deletion = await delayDelete(page, deleted.serverId)
  await openServer(page, survivor.serverId)
  const safePathname = await expectServerLeaf(page, survivor.serverId)

  deletion.release()
  expect((await deletion.response).status()).toBe(204)
  await expect(page).toHaveURL(safePathname)
  await expect(page.getByText("Server deleted", { exact: true })).toBeVisible()
  await page.goBack({ waitUntil: "commit" })

  await expect(page).not.toHaveURL(new RegExp(`/c/channels/${deleted.serverId}(?:/|$)`))
  await expect(page).toHaveURL(/\/c\/channels\/[^/]+\/[^/]+$/)
  await deletion.cleanup()
})

test("a failed DELETE keeps the current route and emits no success frame", async ({ asUser }) => {
  const route = await seedServerRoute("carol", `failed-delete-${Date.now()}`)
  const page = (await asUser("carol")).page
  const deletes = captureServerDeletes(page)
  const pathname = `/c/channels/${route.serverId}/${route.channelId}`
  await gotoAfterUserWsAuth(page, pathname)
  const pattern = `**/api/community/servers/${route.serverId}`
  await page.route(pattern, async (request) => {
    if (request.request().method() !== "DELETE") {
      await request.continue()
      return
    }
    await request.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "forced delete failure" }),
    })
  })
  const response = page.waitForResponse((candidate) => (
    candidate.request().method() === "DELETE"
      && new URL(candidate.url()).pathname === `/api/community/servers/${route.serverId}`
  ))

  await clickDeleteServer(page, route.serverId)

  expect((await response).status()).toBe(500)
  await expect(page).toHaveURL(pathname)
  await expect(page.getByText("Server deleted", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId(tid.serverIcon(route.serverId))).toBeVisible()
  await expect(page.getByTestId(tid.channelRow(route.channelId))).toBeVisible()
  await expect(page.getByTestId(tid.composerInput)).toHaveCount(1)
  await expect.poll(() => deletes.frames.filter((frame) => (
    frame.serverId === route.serverId
  ))).toHaveLength(0)
  expect(await serverIds("carol")).toContain(route.serverId)
  await page.unroute(pattern)
})
