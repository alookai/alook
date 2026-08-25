import { type Locator, type Page } from "@playwright/test"
import { test, expect, userId } from "./_fixtures/community-fixture"
import { composerEditable } from "./_fixtures/actions"
import { tid } from "./_fixtures/testids"
import {
  memberInfo,
  renameUser,
  seedChannel,
  seedDm,
  seedJoinServer,
  seedMessage,
  seedServer,
  seedThread,
} from "./_fixtures/seed"

const VIEWPORT_WIDTHS = [375, 639, 640] as const
const LONG_ENGLISH = "overflow".repeat(12) + "edge"
const LONG_CJK = "界".repeat(100)

type Rect = {
  left: number
  right: number
  width: number
  height: number
}

type PlaceholderMetrics = {
  content: string
  composer: Rect
  paragraph: Rect
  naturalTextWidth: number
  pseudoWidth: number | null
  visualTextRight: number
  pseudo: {
    position: string
    whiteSpace: string
    overflowX: string
    textOverflow: string
  }
  attach: Rect | null
  emoji: Rect | null
}

async function placeholderMetrics(composer: Locator): Promise<PlaceholderMetrics> {
  const paragraph = composer.locator(".tiptap p.is-editor-empty").first()
  await expect(paragraph).toBeVisible()
  return paragraph.evaluate((node, ids) => {
    const element = node as HTMLElement
    const composerElement = element.closest(`[data-testid='${ids.composerInput}']`) as HTMLElement
    const pseudo = getComputedStyle(element, "::before")
    const text = element.dataset.placeholder ?? ""
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")!
    const elementStyle = getComputedStyle(element)
    context.font = elementStyle.font || `${elementStyle.fontSize} ${elementStyle.fontFamily}`
    const naturalTextWidth = context.measureText(text).width
    const paragraphRect = element.getBoundingClientRect()
    const composerRect = composerElement.getBoundingClientRect()
    const clipsHorizontally = pseudo.overflowX === "hidden" || pseudo.overflowX === "clip"
    const attachElement = composerElement.parentElement?.querySelector<HTMLElement>(
      `[data-testid='${ids.composerAttach}']`,
    )
    const emojiElement = composerElement.parentElement?.querySelector<HTMLElement>(
      "button[aria-label='Emoji picker']",
    )
    const toRect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      width: value.width,
      height: value.height,
    })
    const parsedPseudoWidth = Number.parseFloat(pseudo.width)
    return {
      content: text,
      composer: toRect(composerRect),
      paragraph: toRect(paragraphRect),
      naturalTextWidth,
      pseudoWidth: Number.isFinite(parsedPseudoWidth) ? parsedPseudoWidth : null,
      visualTextRight: element.getBoundingClientRect().left
        + (clipsHorizontally ? Math.min(naturalTextWidth, paragraphRect.width) : naturalTextWidth),
      pseudo: {
        position: pseudo.position,
        whiteSpace: pseudo.whiteSpace,
        overflowX: pseudo.overflowX,
        textOverflow: pseudo.textOverflow,
      },
      attach: attachElement ? toRect(attachElement.getBoundingClientRect()) : null,
      emoji: emojiElement ? toRect(emojiElement.getBoundingClientRect()) : null,
    }
  }, { composerInput: tid.composerInput, composerAttach: tid.composerAttach })
}

function expectContainedPlaceholder(metrics: PlaceholderMetrics, expected: string, width: number): void {
  const evidence = `viewport=${width} metrics=${JSON.stringify(metrics)}`
  expect(metrics.content, evidence).toBe(expected)
  expect(metrics.composer.height, evidence).toBeCloseTo(48, 0)
  expect(metrics.pseudo.position, evidence).toBe("absolute")
  expect(metrics.pseudo.whiteSpace, evidence).toBe("nowrap")
  expect(metrics.pseudo.overflowX, evidence).toBe("hidden")
  expect(metrics.pseudo.textOverflow, evidence).toBe("ellipsis")
  expect(metrics.pseudoWidth, evidence).not.toBeNull()
  expect(metrics.pseudoWidth!, evidence).toBeLessThanOrEqual(metrics.paragraph.width + 0.5)
  expect(metrics.visualTextRight, evidence).toBeLessThanOrEqual(metrics.paragraph.right + 0.5)
  if (metrics.attach) {
    expect(metrics.attach.right, evidence).toBeLessThanOrEqual(metrics.paragraph.left + 0.5)
  }
  if (metrics.emoji) {
    expect(metrics.paragraph.right, evidence).toBeLessThanOrEqual(metrics.emoji.left + 0.5)
  }
}

async function expectChatPlaceholderAtWidths(
  page: Page,
  composer: Locator,
  expected: string,
): Promise<void> {
  let sawOverflowingSource = false
  for (const width of VIEWPORT_WIDTHS) {
    await page.setViewportSize({ width, height: 800 })
    const metrics = await placeholderMetrics(composer)
    sawOverflowingSource ||= metrics.naturalTextWidth > metrics.paragraph.width
    expectContainedPlaceholder(metrics, expected, width)
  }
  expect(sawOverflowingSource).toBe(true)
}

async function ignoreNextDevToolsPointerCapture(page: Page): Promise<void> {
  await page.addStyleTag({
    content: [
      "nextjs-portal { pointer-events: none !important; }",
      ".tsqd-parent-container { pointer-events: none !important; }",
    ].join("\n"),
  })
}

async function suggestionMetrics(option: Locator): Promise<{
  option: Rect
  listClientWidth: number
  listScrollWidth: number
  optionClientWidth: number
  optionScrollWidth: number
  icon: Rect
  label: Rect
  labelStyle: {
    whiteSpace: string
    overflowX: string
    textOverflow: string
  }
  discriminator: Rect | null
}> {
  return option.evaluate((node) => {
    const element = node as HTMLElement
    const list = element.parentElement as HTMLElement
    const icon = element.querySelector<HTMLElement>("[data-suggestion-icon]")!
    const label = element.querySelector<HTMLElement>("[data-suggestion-label]")!
    const labelStyle = getComputedStyle(label)
    const discriminator = element.querySelector<HTMLElement>("[data-suggestion-discriminator]")
    const toRect = (value: DOMRect) => ({
      left: value.left,
      right: value.right,
      width: value.width,
      height: value.height,
    })
    return {
      option: toRect(element.getBoundingClientRect()),
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
      optionClientWidth: element.clientWidth,
      optionScrollWidth: element.scrollWidth,
      icon: toRect(icon.getBoundingClientRect()),
      label: toRect(label.getBoundingClientRect()),
      labelStyle: {
        whiteSpace: labelStyle.whiteSpace,
        overflowX: labelStyle.overflowX,
        textOverflow: labelStyle.textOverflow,
      },
      discriminator: discriminator
        ? toRect(discriminator.getBoundingClientRect())
        : null,
    }
  })
}

function expectContainedSuggestion(
  metrics: Awaited<ReturnType<typeof suggestionMetrics>>,
  evidence: string,
): void {
  expect(metrics.listScrollWidth, evidence).toBeLessThanOrEqual(metrics.listClientWidth)
  expect(metrics.optionScrollWidth, evidence).toBeLessThanOrEqual(metrics.optionClientWidth)
  expect(metrics.icon.width, evidence).toBeGreaterThan(0)
  expect(metrics.icon.left, evidence).toBeGreaterThanOrEqual(metrics.option.left)
  expect(metrics.icon.right, evidence).toBeLessThanOrEqual(metrics.label.left)
  expect(metrics.labelStyle.whiteSpace, evidence).toBe("nowrap")
  expect(metrics.labelStyle.overflowX, evidence).toBe("hidden")
  expect(metrics.labelStyle.textOverflow, evidence).toBe("ellipsis")
  expect(metrics.label.right, evidence).toBeLessThanOrEqual(metrics.option.right + 0.5)
  if (metrics.discriminator) {
    expect(metrics.discriminator.width, evidence).toBeGreaterThan(0)
    expect(metrics.label.right, evidence).toBeLessThanOrEqual(metrics.discriminator.left)
    expect(metrics.discriminator.right, evidence).toBeLessThanOrEqual(metrics.option.right + 0.5)
  }
}

test.describe.serial("community composer text containment", () => {
  let serverId: string
  let longChannelId: string
  let threadId: string
  let forumChannelId: string
  let dmId: string
  let longMemberId: string
  let longMemberDiscriminator: string
  let secondaryServerName: string
  let secondaryChannelSearchToken: string
  let secondaryChannelName: string
  let secondaryChannelId: string

  test.beforeAll(async () => {
    serverId = await seedServer("alice", `overflow-${Date.now()}`)
    longChannelId = await seedChannel("alice", serverId, LONG_ENGLISH)
    forumChannelId = await seedChannel("alice", serverId, `forum-${Date.now()}`, "forum")
    const parentMessageId = await seedMessage("alice", longChannelId, "thread opener")
    threadId = await seedThread("alice", parentMessageId, LONG_CJK)
    await renameUser("bob", LONG_CJK)
    await seedJoinServer("alice", "bob", serverId)
    const longMember = await memberInfo("alice", serverId, userId("bob"))
    longMemberId = longMember.id
    longMemberDiscriminator = longMember.discriminator

    secondaryServerName = `secondary-${"s".repeat(90)}`
    secondaryChannelSearchToken = `overflow-ref-${Date.now()}`
    await seedChannel("alice", serverId, `${secondaryChannelSearchToken}-anchor`)
    secondaryChannelName = `${secondaryChannelSearchToken}-${"c".repeat(72)}`
    const secondaryServerId = await seedServer("alice", secondaryServerName)
    secondaryChannelId = await seedChannel(
      "alice",
      secondaryServerId,
      secondaryChannelName,
    )
    dmId = await seedDm("alice", userId("carol"))
  })

  test("default channel placeholder stays in the editable width and leaves controls clickable", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${longChannelId}`)
    await page.waitForURL(new RegExp(longChannelId), { timeout: 20_000, waitUntil: "commit" })
    await ignoreNextDevToolsPointerCapture(page)
    const composer = page.getByTestId(tid.composerInput)
    await expectChatPlaceholderAtWidths(page, composer, `Message /${LONG_ENGLISH}`)

    await page.setViewportSize({ width: 375, height: 800 })
    const attach = page.getByTestId(tid.composerAttach)
    await attach.click()
    await expect(page.getByRole("menuitem", { name: "Upload a File" })).toBeVisible()
    await page.keyboard.press("Escape")
    const emoji = page.getByRole("button", { name: "Emoji picker" })
    await emoji.click()
    await expect(emoji).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("Escape")
  })

  test("default CJK thread placeholder stays in the editable width", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${threadId}`)
    await page.waitForURL(new RegExp(threadId), { timeout: 20_000, waitUntil: "commit" })
    await expectChatPlaceholderAtWidths(
      page,
      page.getByTestId(tid.composerInput),
      `Message ${LONG_CJK}`,
    )
  })

  test("forum custom placeholder uses the same bounded chat-only rule", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${forumChannelId}`)
    await page.waitForURL(new RegExp(forumChannelId), { timeout: 20_000, waitUntil: "commit" })
    await ignoreNextDevToolsPointerCapture(page)
    await page.getByRole("button", { name: "New Post" }).click()
    const region = page.getByRole("region", { name: "Create post" })
    const composer = region.getByTestId(tid.composerInput)
    for (const width of VIEWPORT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      const metrics = await placeholderMetrics(composer)
      expectContainedPlaceholder(metrics, "What do you want to discuss?", width)
      expect(metrics.attach).toBeNull()
      expect(metrics.emoji).toBeNull()
    }
  })

  test("non-chat TipTap control retains the global placeholder behavior", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.goto(`/c/channels/${serverId}/${longChannelId}`)
    await page.waitForURL(new RegExp(longChannelId), { timeout: 20_000, waitUntil: "commit" })
    await page.locator("body").evaluate((body, placeholder) => {
      const host = document.createElement("div")
      host.id = "non-chat-tiptap-control"
      host.innerHTML = `<div class="tiptap"><p class="is-editor-empty" data-placeholder="${placeholder}"></p></div>`
      body.appendChild(host)
    }, LONG_ENGLISH)
    const style = await page.locator("#non-chat-tiptap-control p").evaluate((node) => {
      const pseudo = getComputedStyle(node, "::before")
      return {
        position: pseudo.position,
        whiteSpace: pseudo.whiteSpace,
        overflowX: pseudo.overflowX,
        textOverflow: pseudo.textOverflow,
        height: pseudo.height,
      }
    })
    expect(style).toEqual({
      position: "static",
      whiteSpace: "normal",
      overflowX: "visible",
      textOverflow: "clip",
      height: "0px",
    })
  })

  test("long mention keeps avatar and discriminator visible without horizontal crop", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`/c/channels/${serverId}/${longChannelId}`)
    await page.waitForURL(new RegExp(longChannelId), { timeout: 20_000, waitUntil: "commit" })
    await ignoreNextDevToolsPointerCapture(page)
    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially("@界")
    const option = page.getByTestId(tid.mentionOption(longMemberId))
    await expect(option).toHaveAttribute("title", `${LONG_CJK}#${longMemberDiscriminator}`)
    for (const width of VIEWPORT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      await expect(option).toBeVisible({ timeout: 15_000 })
      const metrics = await suggestionMetrics(option)
      expectContainedSuggestion(
        metrics,
        `viewport=${width} mention metrics=${JSON.stringify(metrics)}`,
      )
    }
  })

  test("long cross-server channel row truncates within the popup without hard crop", async ({ asUser }) => {
    const { page } = await asUser("alice")
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`/c/me/${dmId}`)
    await page.waitForURL(new RegExp(dmId), { timeout: 20_000, waitUntil: "commit" })
    await ignoreNextDevToolsPointerCapture(page)
    const editable = composerEditable(page)
    await editable.click()
    await editable.pressSequentially(`/${secondaryChannelSearchToken}`)
    const option = page.getByTestId(tid.channelRefOption(secondaryChannelId))
    await expect(option).toHaveAttribute(
      "title",
      `${secondaryServerName} / ${secondaryChannelName}`,
    )
    for (const width of VIEWPORT_WIDTHS) {
      await page.setViewportSize({ width, height: 800 })
      await expect(option).toBeVisible({ timeout: 15_000 })
      const metrics = await suggestionMetrics(option)
      expectContainedSuggestion(
        metrics,
        `viewport=${width} channel-ref metrics=${JSON.stringify(metrics)}`,
      )
    }
  })
})
