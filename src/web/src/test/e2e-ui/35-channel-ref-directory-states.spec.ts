import type { Page } from "@playwright/test"
import { expect, test, type CaseActors } from "./_fixtures/case-fixture"
import { composerEditable } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"

const DIRECTORY_PATH = "/api/community/users/me/channel-directory"
const STATUS_HISTORY_KEY = "__channelRefStatusHistory"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function directoryEnvelope(serverId: string, channelId: string) {
  return {
    directory: [{
      id: serverId,
      name: "Channel reference states",
      discriminator: "0042",
      channels: [{ id: channelId, name: "general" }],
    }],
  }
}

async function installStatusRecorder(page: Page) {
  await page.evaluate(({ statusTestId, historyKey }) => {
    const states: string[] = []
    const record = () => {
      const status = document.querySelector(
        `[data-testid="${statusTestId}"]`,
      )?.getAttribute("data-state")
      if (status && states.at(-1) !== status) states.push(status)
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    })
    record()
    Reflect.set(window, historyKey, { states, observer })
  }, { statusTestId: tid.channelRefStatus, historyKey: STATUS_HISTORY_KEY })
}

async function readStatusHistory(page: Page): Promise<string[]> {
  return page.evaluate((historyKey) => {
    const recorder = Reflect.get(window, historyKey) as
      | { states: string[]; observer: MutationObserver }
      | undefined
    recorder?.observer.disconnect()
    return recorder?.states ?? []
  }, STATUS_HISTORY_KEY)
}

async function closeSuggestion(page: Page) {
  const editable = composerEditable(page)
  await editable.press("ControlOrMeta+A")
  await editable.press("Backspace")
  await expect(page.getByTestId(tid.channelRefPopup)).toHaveCount(0)
}

async function seedDirectoryCase(actors: CaseActors) {
  const { seedServer, seedChannel, seedDm } = actors.seed
  const { userId } = actors
  const serverId = await seedServer("alice", `Channel ref states ${Date.now()}`)
  const channelId = await seedChannel("alice", serverId, "general")
  const firstDmId = await seedDm("alice", userId("bob"))
  const secondDmId = await seedDm("alice", userId("carol"))
  return { serverId, channelId, firstDmId, secondDmId }
}

test.describe("DM channel-reference directory states", () => {
  test.setTimeout(120_000)

  test("cold pending stays anchored through query updates and resolves without false-empty", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId, firstDmId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    const gate = deferred()
    actors.onCleanup(async () => { gate.resolve() })
    let directoryGets = 0
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      directoryGets += 1
      await gate.promise
      await route.fulfill({ status: 200, json: directoryEnvelope(serverId, channelId) })
    })

    await page.goto(`/c/me/${firstDmId}`)
    const editable = composerEditable(page)
    await expect(editable).toBeVisible({ timeout: 20_000 })
    await installStatusRecorder(page)
    await editable.click()
    await editable.pressSequentially("/")
    const popup = page.getByTestId(tid.channelRefPopup)
    const status = page.getByTestId(tid.channelRefStatus)
    await expect(popup).toBeVisible()
    await expect(status).toHaveAttribute("data-state", "loading")
    await expect.poll(() => directoryGets).toBe(1)

    await editable.pressSequentially("gen")
    await expect(status).toHaveAttribute("data-state", "loading")
    expect(directoryGets).toBe(1)
    gate.resolve()

    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    await expect(popup).toBeVisible()
    expect(await readStatusHistory(page)).toEqual(["loading"])
    expect(directoryGets).toBe(1)
  })

  test("resolved empty stays anchored with explicit copy", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { firstDmId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    let directoryGets = 0
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      directoryGets += 1
      await route.fulfill({ status: 200, json: { directory: [] } })
    })

    await page.goto(`/c/me/${firstDmId}`)
    const editable = composerEditable(page)
    await expect(editable).toBeVisible({ timeout: 20_000 })
    await editable.click()
    await editable.pressSequentially("/")
    const status = page.getByTestId(tid.channelRefStatus)
    await expect(status).toHaveAttribute("data-state", "empty")
    await expect(status).toHaveText("No matching channels")
    await expect(page.getByTestId(tid.channelRefPopup)).toBeVisible()
    expect(directoryGets).toBe(1)
  })

  test("cold 500 is one attempt, same-popup input is inert, and a new session retries once", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId, firstDmId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    const statuses: number[] = []
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      const status = statuses.length === 0 ? 500 : 200
      statuses.push(status)
      if (status === 500) {
        await route.fulfill({ status, json: { error: "forced failure" } })
        return
      }
      await route.fulfill({ status, json: directoryEnvelope(serverId, channelId) })
    })

    await page.goto(`/c/me/${firstDmId}`)
    const editable = composerEditable(page)
    await expect(editable).toBeVisible({ timeout: 20_000 })
    await editable.click()
    await editable.pressSequentially("/")
    const status = page.getByTestId(tid.channelRefStatus)
    await expect(status).toHaveAttribute("data-state", "error")
    await expect(status).toHaveText("Couldn’t load channels")
    expect(statuses).toEqual([500])

    await editable.pressSequentially("gen")
    await expect(status).toHaveAttribute("data-state", "error")
    expect(statuses).toEqual([500])

    await closeSuggestion(page)
    await editable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    expect(statuses).toEqual([500, 200])
  })

  test("warm cache crosses DM routes without a duplicate request or status flash", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId, firstDmId, secondDmId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    let directoryGets = 0
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      directoryGets += 1
      await route.fulfill({ status: 200, json: directoryEnvelope(serverId, channelId) })
    })

    await page.goto(`/c/me/${firstDmId}`)
    const firstEditable = composerEditable(page)
    await expect(firstEditable).toBeVisible({ timeout: 20_000 })
    await firstEditable.click()
    await firstEditable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    expect(directoryGets).toBe(1)
    await closeSuggestion(page)

    await page.getByTestId(tid.dmRow(secondDmId)).click()
    await page.waitForURL(new RegExp(`/c/me/${secondDmId}$`), {
      timeout: 20_000,
      waitUntil: "commit",
    })
    const secondEditable = composerEditable(page)
    await expect(secondEditable).toBeVisible({ timeout: 20_000 })
    await installStatusRecorder(page)
    await secondEditable.click()
    await secondEditable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    expect(await readStatusHistory(page)).toEqual([])
    expect(directoryGets).toBe(1)
  })

  test("late completion after exit and SPA route switch only warms the new DM", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId, firstDmId, secondDmId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    const gate = deferred()
    actors.onCleanup(async () => { gate.resolve() })
    let directoryGets = 0
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      directoryGets += 1
      await gate.promise
      await route.fulfill({ status: 200, json: directoryEnvelope(serverId, channelId) })
    })

    await page.goto(`/c/me/${firstDmId}`)
    const firstEditable = composerEditable(page)
    await expect(firstEditable).toBeVisible({ timeout: 20_000 })
    await firstEditable.click()
    await firstEditable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefStatus)).toHaveAttribute(
      "data-state",
      "loading",
    )
    expect(directoryGets).toBe(1)
    await closeSuggestion(page)

    await page.getByTestId(tid.dmRow(secondDmId)).click()
    await page.waitForURL(new RegExp(`/c/me/${secondDmId}$`), {
      timeout: 20_000,
      waitUntil: "commit",
    })
    gate.resolve()
    await expect.poll(() => directoryGets).toBe(1)
    await expect(page.getByTestId(tid.channelRefPopup)).toHaveCount(0)

    const secondEditable = composerEditable(page)
    await expect(secondEditable).toBeVisible({ timeout: 20_000 })
    await secondEditable.click()
    await secondEditable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    expect(directoryGets).toBe(1)
  })

  test("server channel keeps local categories and never requests the directory", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob", "carol"])
    const { asUser } = actors
    const { serverId, channelId } = await seedDirectoryCase(actors)

    const { page } = await asUser("alice")
    let directoryGets = 0
    await page.route(`**${DIRECTORY_PATH}`, async (route) => {
      directoryGets += 1
      await route.continue()
    })

    await page.goto(`/c/channels/${serverId}/${channelId}`)
    const editable = composerEditable(page)
    await expect(editable).toBeVisible({ timeout: 20_000 })
    await editable.click()
    await editable.pressSequentially("/")
    await expect(page.getByTestId(tid.channelRefOption(channelId))).toBeVisible()
    await expect(page.getByTestId(tid.channelRefStatus)).toHaveCount(0)
    expect(directoryGets).toBe(0)
  })
})

async function serverHandle(page: Page, serverId: string) {
  const response = await page.request.get("/api/community/users/me/channel-directory")
  expect(response.status()).toBe(200)
  const data = await response.json() as { directory: Array<{ id: string; name: string; discriminator: string }> }
  const server = data.directory.find(row => row.id === serverId)
  expect(server).toBeTruthy()
  return `${server!.name}#${server!.discriminator}`
}

async function prepare(actors: CaseActors) {
  const serverId = await actors.seed.seedServer("alice", `Ref pages ${Date.now()}`)
  const forumId = await actors.seed.seedChannel("alice", serverId, "ref-forum", "forum")
  const textId = await actors.seed.seedChannel("alice", serverId, "ref-chat")
  const archivedId = await actors.seed.seedForumThread("alice", forumId, "Archived reference destination", "Archived destination content")
  const activeId = await actors.seed.seedForumThread("alice", forumId, "Active reference destination", "Active destination content")
  const dmId = await actors.seed.seedDm("alice", actors.userId("bob"))
  return { serverId, forumId, textId, archivedId, activeId, dmId }
}

test.describe("channel ref page navigation", () => {
  test("DM numbered refs open active/archived pages with mouse, keyboard and touch while preserving archive state", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const { serverId, forumId, textId, archivedId, activeId, dmId } = await prepare(actors)
    const { page } = await actors.asUser("alice", { hasTouch: true, viewport: { width: 1280, height: 900 } })
    const handle = await serverHandle(page, serverId)
    const archiveRef = `/${handle}/ref-forum/#1#18`
    const activeRef = `/${handle}/ref-forum/#2#11`
    const textRef = `/${handle}/ref-chat#27`
    await actors.seed.seedDmMessage("alice", dmId, `${archiveRef} ${activeRef} ${textRef}`)
    await actors.seed.seedMessage("alice", textId, `${archiveRef} ${activeRef}`)
    await page.goto(`/c/channels/${serverId}/${forumId}`)
    const card = page.getByTestId(tid.forumThreadCard(archivedId))
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.hover()
    const archived = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/tags"))
    await page.getByTestId(tid.forumThreadArchiveBtn(archivedId)).click()
    expect((await archived).status()).toBe(200)
    await expect(card).toHaveCount(0)
    const before = await page.request.get(`/api/community/channels/${archivedId}`)
    expect(before.status()).toBe(200)
    const beforeMetadata = await before.json() as { archived: boolean }

    const resolvedRefs: string[] = []
    page.on("request", request => {
      const url = new URL(request.url())
      if (url.pathname === "/api/community/channel-ref") {
        expect(request.method()).toBe("GET")
        resolvedRefs.push(url.searchParams.get("ref") ?? "")
      }
    })
    for (const method of ["click", "Enter", "Space", "tap"] as const) {
      await page.goto(`/c/me/${dmId}`)
      const pill = page.getByTestId(tid.channelRefPill(archivedId))
      await expect(pill).toHaveText(/Archived reference destination.*#18/, { timeout: 20_000 })
      if (method === "click") await pill.click()
      else if (method === "tap") await pill.tap()
      else { await pill.focus(); await pill.press(method) }
      await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${archivedId}$`))
    }
    await page.goto(`/c/me/${dmId}`)
    await page.getByTestId(tid.channelRefPill(activeId)).click()
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${activeId}$`))
    await page.goto(`/c/me/${dmId}`)
    await page.getByTestId(tid.channelRefPill(textId)).click()
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${textId}$`))
    await page.getByTestId(tid.channelRefPill(archivedId)).click()
    await expect(page).toHaveURL(new RegExp(`/c/channels/${serverId}/${archivedId}$`))
    expect(resolvedRefs).toContain(`/${handle.toLowerCase()}/ref-forum/#1`)
    expect(resolvedRefs.every(ref => !ref.endsWith("#18") && !ref.endsWith("#11") && !ref.endsWith("#27"))).toBe(true)
    const metadata = await page.request.get(`/api/community/channels/${archivedId}`)
    expect(metadata.status()).toBe(200)
    expect((await metadata.json() as { archived: boolean }).archived).toBe(beforeMetadata.archived)
    const feed = await page.request.get(`/api/community/channels/${forumId}/threads?archived=false`)
    expect(feed.status()).toBe(200)
    const rows = await feed.json() as { threads: Array<{ id: string }> }
    expect(rows.threads.map(row => row.id)).not.toContain(archivedId)
    expect(rows.threads.map(row => row.id)).toContain(activeId)
    const archivedFeed = await page.request.get(`/api/community/channels/${forumId}/threads?tag=archived`)
    expect(archivedFeed.status()).toBe(200)
    const archivedRows = await archivedFeed.json() as { threads: Array<{ id: string }> }
    expect(archivedRows.threads.map(row => row.id)).toContain(archivedId)
  })

  test("a private-parent ref shared in DM stays unavailable to an unrostered server member", async ({ caseActors }) => {
    const actors = await caseActors(["alice", "bob"])
    const serverId = await actors.seed.seedServer("bob", `Private refs ${Date.now()}`)
    await actors.seed.seedJoinServer("bob", "alice", serverId)
    const categoryId = await actors.seed.seedCategory("bob", serverId, "Private", { private: true })
    const forumId = await actors.seed.seedChannel("bob", serverId, "private-ref-forum", "forum", categoryId)
    const postId = await actors.seed.seedForumThread("bob", forumId, "Private title must not appear", "Private body")
    const dmId = await actors.seed.seedDm("bob", actors.userId("alice"))
    const owner = await actors.asUser("bob")
    const handle = await serverHandle(owner.page, serverId)
    const ref = `/${handle}/private-ref-forum/#1#18`
    await actors.seed.seedDmMessage("bob", dmId, ref)
    const { page } = await actors.asUser("alice")
    const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/community/channel-ref")
    await page.goto(`/c/me/${dmId}`)
    const denied = await response
    expect(denied.status()).toBe(403)
    expect(await denied.json()).toEqual({ error: "forbidden" })
    const pill = page.locator('[data-ref-state="forbidden"]').filter({ hasText: ref })
    await expect(pill).toBeVisible()
    await expect(page.getByTestId(tid.channelRefPill(postId))).toHaveCount(0)
    await expect(page.getByText("Private title must not appear")).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/c/me/${dmId}$`))
  })
})
