import type { Locator, Page, TestInfo } from "@playwright/test"
import { test, expect, sessionCookie } from "./_fixtures/community-fixture"
import { gotoAfterUserWsAuth } from "./_fixtures/actions"
import { seedChannel, seedForumThread, seedJoinServer, seedMessage, seedServer } from "./_fixtures/seed"
import { tid } from "./_fixtures/testids"
import { WEB_URL } from "./_setup/paths"

const MOBILE_WIDTHS = [320, 390] as const
const TAGS = ["alpha-long-tag", "beta-long-tag", "gamma", "delta", "epsilon"]

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number }

function intersects(left: Rect, right: Rect): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top
}

async function rect(locator: Locator): Promise<Rect | null> {
  const box = await locator.boundingBox()
  return box === null ? null : {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  }
}

async function expectNewPostGeometry(
  page: Page,
  width: (typeof MOBILE_WIDTHS)[number],
  state: string,
  expected?: Rect,
): Promise<Rect> {
  const geometry = await page.evaluate(([barId, railId, newPostId, fadeLeftId, fadeRightId]) => {
    const bar = document.querySelector(`[data-testid="${barId}"]`) as HTMLElement
    const rail = document.querySelector(`[data-testid="${railId}"]`) as HTMLElement
    const newPost = document.querySelector(`[data-testid="${newPostId}"]`) as HTMLElement
    const toRect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }
    }
    const button = toRect(newPost)
    const centerTarget = document.elementFromPoint(
      button.left + button.width / 2,
      button.top + button.height / 2,
    )?.closest("button")?.getAttribute("data-testid") ?? null
    return {
      viewport: { left: 0, right: document.documentElement.clientWidth, top: 0, bottom: window.innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      barClientWidth: bar.clientWidth,
      barScrollWidth: bar.scrollWidth,
      bar: toRect(bar),
      rail: toRect(rail),
      button,
      centerTarget,
      chips: Array.from(rail.querySelectorAll("button")).map(toRect),
      fades: [fadeLeftId, fadeRightId]
        .map((id) => document.querySelector(`[data-testid="${id}"]`))
        .filter((element): element is Element => element !== null)
        .map(toRect),
    }
  }, [
    tid.forumFilterBar,
    tid.forumTagScroller,
    tid.forumNewPost,
    tid.forumTagFadeLeft,
    tid.forumTagFadeRight,
  ] as const)
  const label = `filter rail@${width}/${state}`
  expect(geometry.documentScrollWidth, `${label}: document containment`).toBe(geometry.viewport.right)
  expect(geometry.barScrollWidth, `${label}: bar containment`).toBe(geometry.barClientWidth)
  expect(geometry.button.left, `${label}: New Post left`).toBeGreaterThanOrEqual(geometry.bar.left - 0.5)
  expect(geometry.button.right, `${label}: New Post bar right`).toBeLessThanOrEqual(geometry.bar.right + 0.5)
  expect(geometry.button.top, `${label}: New Post top`).toBeGreaterThanOrEqual(geometry.bar.top - 0.5)
  expect(geometry.button.bottom, `${label}: New Post bottom`).toBeLessThanOrEqual(geometry.bar.bottom + 0.5)
  expect(geometry.button.left, `${label}: New Post viewport left`).toBeGreaterThanOrEqual(geometry.viewport.left - 0.5)
  expect(geometry.button.right, `${label}: New Post viewport right`).toBeLessThanOrEqual(geometry.viewport.right + 0.5)
  expect(geometry.button.top, `${label}: New Post viewport top`).toBeGreaterThanOrEqual(geometry.viewport.top - 0.5)
  expect(geometry.button.bottom, `${label}: New Post viewport bottom`).toBeLessThanOrEqual(geometry.viewport.bottom + 0.5)
  expect(geometry.centerTarget, `${label}: New Post center hit`).toBe(tid.forumNewPost)
  for (const chip of geometry.chips) {
    const visibleChip = {
      left: Math.max(chip.left, geometry.rail.left),
      right: Math.min(chip.right, geometry.rail.right),
      top: Math.max(chip.top, geometry.rail.top),
      bottom: Math.min(chip.bottom, geometry.rail.bottom),
      width: 0,
      height: 0,
    }
    visibleChip.width = Math.max(0, visibleChip.right - visibleChip.left)
    visibleChip.height = Math.max(0, visibleChip.bottom - visibleChip.top)
    if (visibleChip.width > 0 && visibleChip.height > 0) {
      expect(intersects(geometry.button, visibleChip), `${label}: New Post/visible chip overlap`).toBe(false)
    }
  }
  for (const fade of geometry.fades) {
    expect(intersects(geometry.button, fade), `${label}: New Post/fade overlap`).toBe(false)
  }
  if (expected) {
    for (const edge of ["left", "right", "top", "bottom", "width", "height"] as const) {
      expect(Math.abs(geometry.button[edge] - expected[edge]), `${label}: stable ${edge}`).toBeLessThanOrEqual(0.5)
    }
  }
  return geometry.button
}

function observeClientWrites(page: Page) {
  const state = { active: false, http: [] as string[], ws: [] as string[] }
  page.on("request", (request) => {
    if (!state.active || ["GET", "HEAD", "OPTIONS"].includes(request.method())) return
    const path = new URL(request.url()).pathname
    if (!path.startsWith("/api/community/")) return
    if (path.endsWith("/read")) return
    state.http.push(`${request.method()} ${path}`)
  })
  page.on("websocket", (socket) => {
    socket.on("framesent", (payload) => {
      if (!state.active) return
      const raw = String(payload)
      try {
        const frame = JSON.parse(raw) as { type?: unknown }
        if (typeof frame.type === "string" && frame.type.startsWith("community:")) {
          state.ws.push(frame.type)
        }
      } catch {
        return
      }
    })
  })
  return state
}

async function expectMobileGeometry(
  page: Page,
  card: Locator,
  postId: string,
  visibleTags: string[],
  titleState: "single" | "double" | "truncated",
  role: "author" | "manager",
  width: (typeof MOBILE_WIDTHS)[number],
): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  const tagButton = page.getByTestId(tid.forumThreadTagBtn(postId))
  const deleteButton = page.getByTestId(tid.forumThreadDeleteBtn(postId))
  await expect(tagButton).toHaveCSS("opacity", "1")
  await expect(deleteButton).toHaveCSS("opacity", "1")

  const title = page.getByTestId(tid.forumThreadTitle(postId))
  const titleText = page.getByTestId(tid.forumThreadTitleText(postId))
  const sequence = page.getByTestId(tid.forumThreadSeq(postId))
  await expect(title).toHaveAttribute("data-truncated", titleState === "truncated" ? "true" : "false")
  await expect(sequence).toBeVisible()
  const [listRect, cardRect, titleRect, tagRect, deleteRect, sequenceRect] = await Promise.all([
    rect(page.getByTestId(tid.forumPostList)),
    rect(card),
    rect(title),
    rect(tagButton),
    rect(deleteButton),
    rect(sequence),
  ])
  for (const renderedRect of [listRect, cardRect, titleRect, tagRect, deleteRect, sequenceRect]) {
    expect(renderedRect, `${role}/${postId}@${width}: expected rendered geometry`).not.toBeNull()
  }
  expect(Math.abs(cardRect!.left - listRect!.left), `${role}/${postId}@${width}: edge-to-edge left`).toBeLessThanOrEqual(0.5)
  expect(Math.abs(cardRect!.right - listRect!.right), `${role}/${postId}@${width}: edge-to-edge right`).toBeLessThanOrEqual(0.5)
  expect(titleRect!.left - cardRect!.left, `${role}/${postId}@${width}: internal title inset`).toBeGreaterThanOrEqual(16)
  const titleMetrics = await title.evaluate((element) => {
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
    return { height: element.getBoundingClientRect().height, lineHeight }
  })
  const textFragments = await titleText.evaluate((element) => Array.from(element.getClientRects())
    .filter((fragment) => fragment.width > 0 && fragment.height > 0)
    .map((fragment) => ({ left: fragment.left, right: fragment.right, top: fragment.top, bottom: fragment.bottom })))
  const textLines = textFragments.reduce<typeof textFragments>((lines, fragment) => {
    const line = lines.find((candidate) => Math.abs(candidate.top - fragment.top) <= 1)
    if (line) {
      line.left = Math.min(line.left, fragment.left)
      line.right = Math.max(line.right, fragment.right)
      line.bottom = Math.max(line.bottom, fragment.bottom)
    } else {
      lines.push({ ...fragment })
    }
    return lines
  }, [])
  const expectedLines = titleState === "single" ? 1 : 2
  expect(textLines, `${role}/${postId}@${width}: visible title lines`).toHaveLength(expectedLines)
  expect(titleMetrics.height, `${role}/${postId}@${width}: two-line clamp`).toBeLessThanOrEqual(titleMetrics.lineHeight * 2 + 0.5)
  const lastTextLine = textLines.at(-1)!
  expect(Math.abs(sequenceRect!.top - lastTextLine.top), `${role}/${postId}@${width}: seq line`).toBeLessThanOrEqual(3)
  expect(Math.abs(sequenceRect!.bottom - lastTextLine.bottom), `${role}/${postId}@${width}: seq baseline`).toBeLessThanOrEqual(3)
  expect(sequenceRect!.left - lastTextLine.right, `${role}/${postId}@${width}: seq gap`).toBeGreaterThanOrEqual(4)
  expect(sequenceRect!.left - lastTextLine.right, `${role}/${postId}@${width}: seq gap`).toBeLessThanOrEqual(8)
  const controls = [tagRect!, deleteRect!]
  for (const controlRect of controls) {
    expect(controlRect.width, `${role}/${postId}@${width}: touch width`).toBe(32)
    expect(controlRect.height, `${role}/${postId}@${width}: touch height`).toBe(32)
    expect(controlRect.left, `${role}/${postId}@${width}: control left`).toBeGreaterThanOrEqual(cardRect!.left)
    expect(controlRect.right, `${role}/${postId}@${width}: control right`).toBeLessThanOrEqual(cardRect!.right)
    expect(controlRect.top, `${role}/${postId}@${width}: control top`).toBeGreaterThanOrEqual(cardRect!.top)
    expect(controlRect.bottom, `${role}/${postId}@${width}: control bottom`).toBeLessThanOrEqual(cardRect!.bottom)
    expect(intersects(titleRect!, controlRect), `${role}/${postId}@${width}: title/action overlap`).toBe(false)
    const centerTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      return target?.closest("button")?.getAttribute("data-testid") ?? null
    }, { x: controlRect.left + controlRect.width / 2, y: controlRect.top + controlRect.height / 2 })
    expect(centerTarget, `${role}/${postId}@${width}: pointer target`).not.toBeNull()
  }
  expect(intersects(tagRect!, deleteRect!), `${role}/${postId}@${width}: action overlap`).toBe(false)
  for (const tag of visibleTags) {
    const tagRect = await rect(card.getByText(`#${tag}`, { exact: true }))
    expect(tagRect, `${role}/${postId}@${width}: tag geometry`).not.toBeNull()
    expect(controls.some((controlRect) => intersects(tagRect!, controlRect)), `${role}/${postId}@${width}: tag/action overlap`).toBe(false)
  }

  const documentWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))
  expect(documentWidth.scroll, `${role}@${width}: horizontal overflow`).toBe(documentWidth.client)
}

async function expectMobileFilterRail(
  page: Page,
  width: (typeof MOBILE_WIDTHS)[number],
  testInfo: TestInfo,
): Promise<Rect> {
  await page.setViewportSize({ width, height: 844 })
  const bar = page.getByTestId(tid.forumFilterBar)
  const rail = page.getByTestId(tid.forumTagScroller)
  const all = page.getByTestId(tid.forumTagAll)
  const last = page.getByTestId(tid.forumTagChip(TAGS.at(-1)!))
  const fadeLeft = page.getByTestId(tid.forumTagFadeLeft)
  const fadeRight = page.getByTestId(tid.forumTagFadeRight)
  const originalColorScheme = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expect(bar).toBeVisible()
  await expect(rail).toBeVisible()
  const initial = await rail.evaluate((element) => {
    const style = getComputedStyle(element)
    element.scrollLeft = 0
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      flexWrap: style.flexWrap,
      overflowX: style.overflowX,
    }
  })
  expect(initial.flexWrap, `filter rail@${width}: single line`).toBe("nowrap")
  expect(initial.overflowX, `filter rail@${width}: horizontal scroll`).toBe("auto")
  expect(initial.scrollWidth, `filter rail@${width}: owns overflow`).toBeGreaterThan(initial.clientWidth)
  await expect(fadeLeft).toHaveCount(0)
  await expect(fadeRight).toBeVisible()
  const startFadeStyle = await fadeRight.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      width: element.getBoundingClientRect().width,
      backgroundImage: style.backgroundImage,
      pointerEvents: style.pointerEvents,
    }
  })
  expect(startFadeStyle.width, `filter rail@${width}: fade width`).toBeGreaterThanOrEqual(12)
  expect(startFadeStyle.width, `filter rail@${width}: fade width`).toBeLessThanOrEqual(16)
  expect(startFadeStyle.backgroundImage, `filter rail@${width}: fade gradient`).toContain("linear-gradient")
  expect(startFadeStyle.pointerEvents, `filter rail@${width}: pointer transparency`).toBe("none")
  const initialNewPostRect = await expectNewPostGeometry(page, width, "start-light")
  await testInfo.attach(`author-${width}-filter-rail-start-light.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expectNewPostGeometry(page, width, "start-dark", initialNewPostRect)
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/dark/)

  await rail.focus()
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await rail.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2
  })
  await expect(fadeLeft).toBeVisible()
  await expect(fadeRight).toBeVisible()
  await expectNewPostGeometry(page, width, "middle-light", initialNewPostRect)
  const pointerHit = await page.evaluate(([railId, fadeId]) => {
    const railElement = document.querySelector(`[data-testid="${railId}"]`) as HTMLElement
    const fadeElement = document.querySelector(`[data-testid="${fadeId}"]`) as HTMLElement
    const fadeRect = fadeElement.getBoundingClientRect()
    const candidates = Array.from(railElement.querySelectorAll<HTMLButtonElement>("button"))
      .map((button) => {
        const buttonRect = button.getBoundingClientRect()
        const left = Math.max(buttonRect.left, fadeRect.left)
        const right = Math.min(buttonRect.right, fadeRect.right)
        return { button, buttonRect, left, right, overlap: right - left }
      })
      .filter((candidate) => candidate.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
    const candidate = candidates[0]
    if (!candidate) return null
    const x = (candidate.left + candidate.right) / 2
    const y = candidate.buttonRect.top + candidate.buttonRect.height / 2
    return {
      expected: candidate.button.dataset.testid ?? null,
      actual: document.elementFromPoint(x, y)?.closest("button")?.getAttribute("data-testid") ?? null,
    }
  }, [tid.forumTagScroller, tid.forumTagFadeRight] as const)
  expect(pointerHit, `filter rail@${width}: chip beneath fade`).not.toBeNull()
  expect(pointerHit!.actual, `filter rail@${width}: fade pointer pass-through`).toBe(pointerHit!.expected)
  const lightGradient = await fadeRight.evaluate((element) => getComputedStyle(element).backgroundImage)
  await testInfo.attach(`author-${width}-filter-rail-middle-light.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  const darkGradient = await fadeRight.evaluate((element) => getComputedStyle(element).backgroundImage)
  expect(darkGradient, `filter rail@${width}: dark fade gradient`).toContain("linear-gradient")
  expect(darkGradient, `filter rail@${width}: theme-aware fade`).not.toBe(lightGradient)
  await expectNewPostGeometry(page, width, "middle-dark", initialNewPostRect)
  await testInfo.attach(`author-${width}-filter-rail-middle-dark.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await page.emulateMedia({ colorScheme: originalColorScheme })
  if (originalColorScheme === "dark") {
    await expect(page.locator("html")).toHaveClass(/dark/)
  } else {
    await expect(page.locator("html")).not.toHaveClass(/dark/)
  }

  await page.keyboard.press("End")
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(fadeLeft).toBeVisible()
  await expect(fadeRight).toHaveCount(0)
  const [railAtEnd, lastAtEnd] = await Promise.all([rect(rail), rect(last)])
  expect(lastAtEnd!.left, `filter rail@${width}: last chip left`).toBeGreaterThanOrEqual(railAtEnd!.left - 0.5)
  expect(lastAtEnd!.right, `filter rail@${width}: last chip right`).toBeLessThanOrEqual(railAtEnd!.right + 0.5)
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expectNewPostGeometry(page, width, "end-light", initialNewPostRect)
  await testInfo.attach(`author-${width}-filter-rail-end.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expectNewPostGeometry(page, width, "end-dark", initialNewPostRect)
  await page.emulateMedia({ colorScheme: originalColorScheme })
  if (originalColorScheme === "dark") {
    await expect(page.locator("html")).toHaveClass(/dark/)
  } else {
    await expect(page.locator("html")).not.toHaveClass(/dark/)
  }

  await last.click()
  await expect(last).toHaveClass(/ring-current/)
  const [railWithLastActive, activeLast] = await Promise.all([rect(rail), rect(last)])
  expect(activeLast!.left).toBeGreaterThanOrEqual(railWithLastActive!.left - 0.5)
  expect(activeLast!.right).toBeLessThanOrEqual(railWithLastActive!.right + 0.5)
  await rail.focus()
  await page.keyboard.press("Home")
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect(fadeLeft).toHaveCount(0)
  await expect(fadeRight).toBeVisible()
  await all.click()
  await expect(all).toHaveClass(/bg-accent/)
  const [railAtStart, allAtStart] = await Promise.all([rect(rail), rect(all)])
  expect(allAtStart!.left).toBeGreaterThanOrEqual(railAtStart!.left - 0.5)
  expect(allAtStart!.right).toBeLessThanOrEqual(railAtStart!.right + 0.5)

  const containment = await page.evaluate(([barId, railId]) => {
    const barElement = document.querySelector(`[data-testid="${barId}"]`) as HTMLElement
    const railElement = document.querySelector(`[data-testid="${railId}"]`) as HTMLElement
    return {
      documentClient: document.documentElement.clientWidth,
      documentScroll: document.documentElement.scrollWidth,
      barClient: barElement.clientWidth,
      barScroll: barElement.scrollWidth,
      railClient: railElement.clientWidth,
      railScroll: railElement.scrollWidth,
    }
  }, [tid.forumFilterBar, tid.forumTagScroller] as const)
  expect(containment.documentScroll, `filter rail@${width}: document containment`).toBe(containment.documentClient)
  expect(containment.barScroll, `filter rail@${width}: bar containment`).toBe(containment.barClient)
  expect(containment.railScroll, `filter rail@${width}: local overflow`).toBeGreaterThan(containment.railClient)
  return initialNewPostRect
}

async function expectNoOverflowFilterRail(
  page: Page,
  width: (typeof MOBILE_WIDTHS)[number],
  route: string,
  postId: string,
  expectedNewPost: Rect,
  testInfo: TestInfo,
): Promise<void> {
  await page.setViewportSize({ width, height: 844 })
  await page.goto(`${WEB_URL}${route}`)
  await expect(page.getByTestId(tid.forumThreadCard(postId))).toBeVisible({ timeout: 20_000 })
  const originalColorScheme = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  const rail = page.getByTestId(tid.forumTagScroller)
  const geometry = await rail.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(geometry.scrollWidth, `no-overflow rail@${width}`).toBe(geometry.clientWidth)
  await expect(page.getByTestId(tid.forumTagFadeLeft)).toHaveCount(0)
  await expect(page.getByTestId(tid.forumTagFadeRight)).toHaveCount(0)
  await expectNewPostGeometry(page, width, "no-overflow-light", expectedNewPost)
  await testInfo.attach(`author-${width}-filter-rail-no-overflow.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await page.emulateMedia({ colorScheme: "dark" })
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(page.getByTestId(tid.forumTagFadeLeft)).toHaveCount(0)
  await expect(page.getByTestId(tid.forumTagFadeRight)).toHaveCount(0)
  await expectNewPostGeometry(page, width, "no-overflow-dark", expectedNewPost)
  await page.emulateMedia({ colorScheme: originalColorScheme })
  if (originalColorScheme === "dark") {
    await expect(page.locator("html")).toHaveClass(/dark/)
  } else {
    await expect(page.locator("html")).not.toHaveClass(/dark/)
  }
}

async function seedTags(forumId: string, threadId: string, tags: string[]): Promise<void> {
  const listResponse = await fetch(
    `${WEB_URL}/api/community/channels/${forumId}/threads?order=createdAt&limit=50`,
    { headers: { Cookie: sessionCookie("bob"), Origin: WEB_URL } },
  )
  expect(listResponse.ok).toBe(true)
  const page = await listResponse.json() as {
    threads: Array<{ id: string; parentMessageId: string | null }>
  }
  const openerMessageId = page.threads.find((thread) => thread.id === threadId)?.parentMessageId
  expect(openerMessageId).toBeTruthy()
  const tagResponse = await fetch(`${WEB_URL}/api/community/messages/${openerMessageId}/tags`, {
    method: "PUT",
    headers: {
      Cookie: sessionCookie("bob"),
      "Content-Type": "application/json",
      Origin: WEB_URL,
    },
    body: JSON.stringify({ tags }),
  })
  expect(tagResponse.status).toBe(200)
}

test("forum post actions stay discoverable on mobile without changing permissions", async ({ asUser }, testInfo) => {
  test.setTimeout(120_000)
  const stamp = Date.now().toString().slice(-6)
  const serverId = await seedServer("alice", `Mobile forum actions ${Date.now()}`)
  const forumId = await seedChannel("alice", serverId, "mobile-actions", "forum")
  const compactForumId = await seedChannel("alice", serverId, "compact-tags", "forum")
  await seedJoinServer("alice", "bob", serverId)
  await seedJoinServer("alice", "carol", serverId)
  const primaryPostId = await seedForumThread(
    "bob",
    forumId,
    `UnbrokenForumTitle${Date.now()}${"abcdefghij".repeat(12)}`,
    "mobile action geometry",
  )
  const cjkPostId = await seedForumThread(
    "bob",
    forumId,
    `移动端论坛标题必须换到第二行展示${stamp}`,
    "two tag geometry",
  )
  const noTagPostId = await seedForumThread(
    "bob",
    forumId,
    `One line ${stamp}`,
    "zero tag geometry",
  )
  const compactPostId = await seedForumThread(
    "bob",
    compactForumId,
    `Compact tags ${stamp}`,
    "no overflow rail geometry",
  )
  await seedMessage("carol", primaryPostId, "participant and reply-count coverage")
  await seedTags(forumId, primaryPostId, TAGS)
  await seedTags(forumId, cjkPostId, TAGS.slice(0, 2))
  await seedTags(compactForumId, compactPostId, ["solo"])
  const postCases = [
    { id: primaryPostId, tags: TAGS.slice(0, 2), titleState: "truncated" as const },
    { id: cjkPostId, tags: TAGS.slice(0, 2), titleState: "double" as const },
    { id: noTagPostId, tags: [], titleState: "single" as const },
  ]
  const route = `/c/channels/${serverId}/${forumId}`
  const compactRoute = `/c/channels/${serverId}/${compactForumId}`

  const author = await asUser("bob")
  await author.page.setViewportSize({ width: 1280, height: 900 })
  await gotoAfterUserWsAuth(author.page, route)
  const authorCard = author.page.getByTestId(tid.forumThreadCard(primaryPostId))
  await expect(authorCard).toBeVisible({ timeout: 20_000 })
  await expect(authorCard.getByText(`#${TAGS[0]}`, { exact: true })).toBeVisible()

  const authorWrites = observeClientWrites(author.page)
  authorWrites.active = true
  const newPostGeometry = new Map<(typeof MOBILE_WIDTHS)[number], Rect>()
  for (const width of MOBILE_WIDTHS) {
    newPostGeometry.set(width, await expectMobileFilterRail(author.page, width, testInfo))
    for (const post of postCases) {
      await expectMobileGeometry(
        author.page,
        author.page.getByTestId(tid.forumThreadCard(post.id)),
        post.id,
        post.tags,
        post.titleState,
        "author",
        width,
      )
    }
    await testInfo.attach(`author-${width}.png`, {
      body: await author.page.screenshot(),
      contentType: "image/png",
    })
  }
  authorWrites.active = false
  for (const width of MOBILE_WIDTHS) {
    const expectedNewPost = newPostGeometry.get(width)
    expect(expectedNewPost, `filter rail@${width}: expected baseline New Post geometry`).toBeDefined()
    await expectNoOverflowFilterRail(author.page, width, compactRoute, compactPostId, expectedNewPost!, testInfo)
  }
  await author.page.goto(`${WEB_URL}${route}`)
  await expect(authorCard).toBeVisible({ timeout: 20_000 })
  authorWrites.active = true
  const authorUrl = author.page.url()
  await author.page.setViewportSize({ width: 320, height: 844 })
  await author.page.getByTestId(tid.forumThreadTagBtn(primaryPostId)).click()
  await expect(author.page.getByTestId(tid.forumTagDialog)).toBeVisible()
  await expect(author.page).toHaveURL(authorUrl)
  await author.page.keyboard.press("Escape")
  await author.page.getByTestId(tid.forumThreadDeleteBtn(primaryPostId)).click()
  await expect(author.page.getByRole("heading", { name: "Delete post?" })).toBeVisible()
  await expect(author.page).toHaveURL(authorUrl)
  await author.page.getByRole("button", { name: "Cancel" }).click()
  authorWrites.active = false
  expect(authorWrites.http).toEqual([])
  expect(authorWrites.ws).toEqual([])

  const manager = await asUser("alice")
  const managerWrites = observeClientWrites(manager.page)
  await gotoAfterUserWsAuth(manager.page, route)
  const managerCard = manager.page.getByTestId(tid.forumThreadCard(primaryPostId))
  await expect(managerCard).toBeVisible({ timeout: 20_000 })
  managerWrites.active = true
  for (const width of MOBILE_WIDTHS) {
    for (const post of postCases) {
      await expectMobileGeometry(
        manager.page,
        manager.page.getByTestId(tid.forumThreadCard(post.id)),
        post.id,
        post.tags,
        post.titleState,
        "manager",
        width,
      )
    }
    await testInfo.attach(`manager-${width}.png`, {
      body: await manager.page.screenshot(),
      contentType: "image/png",
    })
  }
  await manager.page.setViewportSize({ width: 1280, height: 900 })
  const [desktopListRect, desktopCardRect] = await Promise.all([
    rect(manager.page.getByTestId(tid.forumPostList)),
    rect(managerCard),
  ])
  expect(desktopCardRect!.left - desktopListRect!.left).toBeGreaterThanOrEqual(15)
  expect(desktopListRect!.right - desktopCardRect!.right).toBeGreaterThanOrEqual(15)
  await manager.page.mouse.move(0, 0)
  const managerTagButton = manager.page.getByTestId(tid.forumThreadTagBtn(primaryPostId))
  const managerDeleteButton = manager.page.getByTestId(tid.forumThreadDeleteBtn(primaryPostId))
  await expect(managerTagButton).toHaveCSS("opacity", "0")
  await expect(managerDeleteButton).toHaveCSS("opacity", "0")
  for (const button of [managerTagButton, managerDeleteButton]) {
    const buttonRect = await rect(button)
    expect(buttonRect?.width).toBe(24)
    expect(buttonRect?.height).toBe(24)
  }
  await managerCard.hover()
  await expect(managerTagButton).toHaveCSS("opacity", "1")
  await expect(managerDeleteButton).toHaveCSS("opacity", "1")
  await manager.page.mouse.move(0, 0)
  await managerTagButton.focus()
  await expect(managerTagButton).toHaveCSS("opacity", "1")
  await managerTagButton.click()
  const managerTagDialog = manager.page.getByTestId(tid.forumTagDialog)
  await expect(managerTagDialog).toBeVisible()
  await manager.page.mouse.move(0, 0)
  await expect(managerTagButton).toHaveCSS("opacity", "1")
  await expect(managerTagDialog).toHaveCSS("opacity", "1")
  await testInfo.attach("manager-desktop-popup.png", {
    body: await manager.page.screenshot(),
    contentType: "image/png",
  })
  await manager.page.keyboard.press("Escape")
  await expect(managerTagDialog).toHaveCount(0)
  await managerDeleteButton.focus()
  await expect(managerDeleteButton).toHaveCSS("opacity", "1")
  managerWrites.active = false
  expect(managerWrites.http).toEqual([])
  expect(managerWrites.ws).toEqual([])
  await testInfo.attach("manager-desktop-focus.png", {
    body: await manager.page.screenshot(),
    contentType: "image/png",
  })

  const unauthorized = await asUser("carol")
  await unauthorized.page.setViewportSize({ width: 390, height: 844 })
  await gotoAfterUserWsAuth(unauthorized.page, route)
  const unauthorizedCard = unauthorized.page.getByTestId(tid.forumThreadCard(primaryPostId))
  await expect(unauthorizedCard).toBeVisible({ timeout: 20_000 })
  for (const post of postCases) {
    await expect(unauthorized.page.getByTestId(tid.forumThreadTagBtn(post.id))).toHaveCount(0)
    await expect(unauthorized.page.getByTestId(tid.forumThreadDeleteBtn(post.id))).toHaveCount(0)
  }
  await unauthorized.page.setViewportSize({ width: 320, height: 844 })
  for (const post of postCases) {
    await expect(unauthorized.page.getByTestId(tid.forumThreadTagBtn(post.id))).toHaveCount(0)
    await expect(unauthorized.page.getByTestId(tid.forumThreadDeleteBtn(post.id))).toHaveCount(0)
  }
  await testInfo.attach("unauthorized-320.png", {
    body: await unauthorized.page.screenshot(),
    contentType: "image/png",
  })

  await authorCard.click()
  await expect(author.page).toHaveURL(new RegExp(`/channels/${serverId}/${primaryPostId}$`))
  await managerCard.focus()
  await managerCard.press("Enter")
  await expect(manager.page).toHaveURL(new RegExp(`/channels/${serverId}/${primaryPostId}$`))
})
