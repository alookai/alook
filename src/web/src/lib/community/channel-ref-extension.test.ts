import { describe, it, expect, vi } from "vitest"
import {
  buildCommunityChannelRefExtension,
  rankChannelRefItems,
  EMPTY_CHANNEL_REF_STATE,
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "./channel-ref-extension"

const candidate = (id: string, name: string, serverId = "s1", serverName = "Studio"): ChannelRefCandidate => ({
  id,
  name,
  serverId,
  serverName,
})

describe("rankChannelRefItems", () => {
  const candidates = [
    candidate("c1", "general"),
    candidate("c2", "gear-talk"),
    candidate("c3", "random"),
  ]

  it("ranks prefix matches before substring matches, case-insensitively", () => {
    const items = rankChannelRefItems(candidates, "GE")
    expect(items.map((i) => i.id)).toEqual(["c1", "c2"])
  })

  it("returns everything (prefix bucket) for an empty query", () => {
    const items = rankChannelRefItems(candidates, "")
    expect(items.map((i) => i.id)).toEqual(["c1", "c2", "c3"])
  })

  it("caps the list at the same limit convention as rankMentionItems (8)", () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`c${i}`, `chan${i}`))
    expect(rankChannelRefItems(many, "").length).toBe(8)
  })

  it("puts substring-only matches after prefix matches", () => {
    const items = rankChannelRefItems(
      [candidate("c1", "abc-general"), candidate("c2", "general")],
      "general",
    )
    expect(items.map((i) => i.id)).toEqual(["c2", "c1"])
  })
})

// Reach into the extension the same way the composer does — read
// `configuration.suggestion.items` off the configured node, mirroring
// `mention-extension.test.ts`'s introspection style (no jsdom/browser).
function getItemsCallback(
  ext: ReturnType<typeof buildCommunityChannelRefExtension>,
): (props: { query: string }) => unknown[] {
  const config = (ext as unknown as { config: { addOptions?: () => { suggestion?: { items?: unknown } } } }).config
  const opts = config.addOptions?.() ?? (ext as unknown as { options?: { suggestion?: { items?: unknown } } }).options
  const items = (opts?.suggestion as { items: (props: { query: string }) => unknown[] } | undefined)?.items
  if (!items) throw new Error("suggestion.items not found")
  return items
}

type RenderNodeProps = {
  options?: { HTMLAttributes?: Record<string, unknown> }
  node: { attrs: { label?: string | null; id?: string | null; serverId?: string | null } }
}

function getRenderFns(ext: ReturnType<typeof buildCommunityChannelRefExtension>): {
  renderText: (props: RenderNodeProps) => string
  renderHTML: (props: RenderNodeProps) => unknown
} {
  const config = (ext as unknown as {
    config: { addOptions?: () => { renderText?: unknown; renderHTML?: unknown } }
  }).config
  const opts =
    config.addOptions?.() ??
    (ext as unknown as { options?: { renderText?: unknown; renderHTML?: unknown } }).options
  const renderText = opts?.renderText as ((props: RenderNodeProps) => string) | undefined
  const renderHTML = opts?.renderHTML as ((props: RenderNodeProps) => unknown) | undefined
  if (!renderText || !renderHTML) throw new Error("renderText/renderHTML not found")
  return { renderText, renderHTML }
}

function getKeyDownCallback(
  ext: ReturnType<typeof buildCommunityChannelRefExtension>,
): (props: { event: KeyboardEvent }) => boolean {
  const config = (ext as unknown as { config: { addOptions?: () => { suggestion?: { render?: unknown } } } }).config
  const opts = config.addOptions?.() ?? (ext as unknown as { options?: { suggestion?: { render?: unknown } } }).options
  const render = (opts?.suggestion as { render?: () => { onKeyDown?: unknown } } | undefined)?.render
  if (!render) throw new Error("suggestion.render not found")
  const handlers = render()
  const onKeyDown = handlers.onKeyDown as ((props: { event: KeyboardEvent }) => boolean) | undefined
  if (!onKeyDown) throw new Error("onKeyDown not found")
  return onKeyDown
}

function build(candidates: ChannelRefCandidate[] = [], popup: ChannelRefPopupState = EMPTY_CHANNEL_REF_STATE) {
  const candidatesRef = { current: candidates }
  const popupRef = { current: popup }
  const setPopup = vi.fn()
  const queryRef = { current: "" }
  const ext = buildCommunityChannelRefExtension({ candidatesRef, popupRef, setPopup, queryRef })
  return { ext, candidatesRef, popupRef, setPopup, queryRef }
}

describe("buildCommunityChannelRefExtension — suggestion.items callback", () => {
  it("reads live candidates via candidatesRef.current", () => {
    const { ext, candidatesRef } = build([candidate("c1", "general")])
    const items = getItemsCallback(ext)
    expect(items({ query: "" })).toEqual([candidate("c1", "general")])

    // Live ref — mutate after the extension is built; items() must see it.
    candidatesRef.current = [candidate("c1", "general"), candidate("c2", "random")]
    expect((items({ query: "" }) as ChannelRefCandidate[]).map((i) => i.id)).toEqual(["c1", "c2"])
  })

  it("updates the shared queryRef.current on each items() call", () => {
    const { ext, queryRef } = build([candidate("c1", "general")])
    const items = getItemsCallback(ext)
    items({ query: "gen" })
    expect(queryRef.current).toBe("gen")
    items({ query: "general" })
    expect(queryRef.current).toBe("general")
  })
})

describe("buildCommunityChannelRefExtension — renderText/renderHTML", () => {
  it("renderText produces /serverId/channelId (id-based, not name-based)", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({ node: { attrs: { id: "chn_abc", serverId: "srv_xyz", label: "general" } } }),
    ).toBe("/srv_xyz/chn_abc")
  })

  it("renderHTML shows a compact /label chip", () => {
    const { ext } = build()
    const { renderHTML } = getRenderFns(ext)
    const spec = renderHTML({ options: { HTMLAttributes: {} }, node: { attrs: { label: "general", id: "chn_abc" } } })
    expect(spec).toEqual(["span", {}, "/general"])
  })

  it("renderHTML falls back to id when label is missing", () => {
    const { ext } = build()
    const { renderHTML } = getRenderFns(ext)
    const spec = renderHTML({ options: { HTMLAttributes: {} }, node: { attrs: { label: null, id: "chn_abc" } } })
    expect(spec).toEqual(["span", {}, "/chn_abc"])
  })

  it("renderText NEVER emits a literal `/null/<id>` when serverId is unset (regression guard)", () => {
    // The `serverId` attribute default is `null`; a paste-from-HTML,
    // drag-drop, or future keyboard flow that commits a node without
    // setting `serverId` used to produce `"/null/chn_abc"` on the wire,
    // rendering as literal broken text to every recipient. Fall back to
    // the visible `/label` (matching renderHTML's own fallback) so the
    // ref stays readable even in this degraded path.
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({ node: { attrs: { id: "chn_abc", serverId: null, label: "general" } } }),
    ).not.toContain("null")
    expect(
      renderText({ node: { attrs: { id: "chn_abc", serverId: null, label: "general" } } }),
    ).toBe("/general")
  })

  it("renderText emits empty string when neither serverId nor label is present", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({ node: { attrs: { id: "chn_abc", serverId: null, label: null } } }),
    ).toBe("")
  })
})

describe("buildCommunityChannelRefExtension — keyboard callback", () => {
  it("ArrowDown/ArrowUp wrap the selectedIndex", () => {
    const items = [candidate("c1", "a"), candidate("c2", "b")]
    const { ext, popupRef, setPopup } = build(items, {
      items,
      selectedIndex: 0,
      command: vi.fn(),
      rect: null,
    })
    const onKeyDown = getKeyDownCallback(ext)

    const down = { key: "ArrowDown", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: down })).toBe(true)
    expect(setPopup).toHaveBeenCalledWith(expect.objectContaining({ selectedIndex: 1 }))

    popupRef.current = { ...popupRef.current, selectedIndex: 0 }
    const up = { key: "ArrowUp", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: up })).toBe(true)
    expect(setPopup).toHaveBeenCalledWith(expect.objectContaining({ selectedIndex: 1 }))
  })

  it("Escape closes the popup", () => {
    const items = [candidate("c1", "a")]
    const { ext, setPopup } = build(items, { items, selectedIndex: 0, command: vi.fn(), rect: null })
    const onKeyDown = getKeyDownCallback(ext)
    const esc = { key: "Escape", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: esc })).toBe(true)
    expect(setPopup).toHaveBeenCalledWith(EMPTY_CHANNEL_REF_STATE)
  })

  it("IME composition bails (returns false) even with the popup open", () => {
    const items = [candidate("c1", "a")]
    const { ext } = build(items, { items, selectedIndex: 0, command: vi.fn(), rect: null })
    const onKeyDown = getKeyDownCallback(ext)
    const enter = { key: "Enter", preventDefault: vi.fn(), isComposing: true } as unknown as KeyboardEvent
    expect(onKeyDown({ event: enter })).toBe(false)
  })

  it("selecting a candidate via Enter calls command with { id, label, serverId } — not the raw ChannelRefCandidate", () => {
    const command = vi.fn()
    const items = [candidate("chn_1", "general", "srv_1", "Studio")]
    const { ext, setPopup } = build(items, { items, selectedIndex: 0, command, rect: null })
    const onKeyDown = getKeyDownCallback(ext)
    const enter = { key: "Enter", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: enter })).toBe(true)
    // Regression guard for the name→label mapping bug: passing the raw
    // candidate through as-is would leave `attrs.label` `null` and silently
    // render "/null" in the in-editor chip.
    expect(command).toHaveBeenCalledWith({ id: "chn_1", label: "general", serverId: "srv_1" })
    expect(command).not.toHaveBeenCalledWith(items[0])
    expect(setPopup).toHaveBeenCalledWith(EMPTY_CHANNEL_REF_STATE)
  })

  it("Tab also selects the highlighted candidate", () => {
    const command = vi.fn()
    const items = [candidate("chn_1", "general", "srv_1", "Studio")]
    const { ext } = build(items, { items, selectedIndex: 0, command, rect: null })
    const onKeyDown = getKeyDownCallback(ext)
    const tab = { key: "Tab", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: tab })).toBe(true)
    expect(command).toHaveBeenCalledWith({ id: "chn_1", label: "general", serverId: "srv_1" })
  })

  it("returns false when there are no items (popup effectively closed)", () => {
    const { ext } = build([], { ...EMPTY_CHANNEL_REF_STATE })
    const onKeyDown = getKeyDownCallback(ext)
    const enter = { key: "Enter", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: enter })).toBe(false)
  })
})
