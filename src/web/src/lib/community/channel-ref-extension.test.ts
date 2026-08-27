import { describe, it, expect, vi } from "vitest"
import {
  buildCommunityChannelRefExtension,
  rankChannelRefItems,
  toChannelRefCandidate,
  toChannelRefCommandProps,
  EMPTY_CHANNEL_REF_STATE,
  type ChannelRefCandidate,
  type ChannelRefPopupState,
} from "./channel-ref-extension"

const candidate = (
  id: string,
  name: string,
  serverId = "s1",
  serverName = "Studio",
  serverDiscriminator = "0042",
): ChannelRefCandidate => ({
  id,
  name,
  serverId,
  serverName,
  serverDiscriminator,
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
  node: {
    attrs: {
      label?: string | null
      id?: string | null
      serverId?: string | null
      serverName?: string | null
    }
  }
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

function getExitCallback(
  ext: ReturnType<typeof buildCommunityChannelRefExtension>,
): () => void {
  const config = (ext as unknown as { config: { addOptions?: () => { suggestion?: { render?: unknown } } } }).config
  const opts = config.addOptions?.() ?? (ext as unknown as { options?: { suggestion?: { render?: unknown } } }).options
  const render = (opts?.suggestion as { render?: () => { onExit?: unknown } } | undefined)?.render
  if (!render) throw new Error("suggestion.render not found")
  const onExit = render().onExit as (() => void) | undefined
  if (!onExit) throw new Error("suggestion.onExit not found")
  return onExit
}

function getPopupLifecycleCallbacks(
  ext: ReturnType<typeof buildCommunityChannelRefExtension>,
): {
  onStart: (props: {
    items: ChannelRefCandidate[]
    query?: string
    command: () => void
    clientRect?: () => DOMRect | null
  }) => void
  onUpdate: (props: {
    items: ChannelRefCandidate[]
    query?: string
    command: () => void
    clientRect?: () => DOMRect | null
  }) => void
} {
  const config = (ext as unknown as {
    config: { addOptions?: () => { suggestion?: { render?: unknown } } }
  }).config
  const opts = config.addOptions?.()
    ?? (ext as unknown as { options?: { suggestion?: { render?: unknown } } }).options
  const render = (opts?.suggestion as {
    render?: () => { onStart?: unknown; onUpdate?: unknown }
  } | undefined)?.render
  if (!render) throw new Error("suggestion.render not found")
  const { onStart, onUpdate } = render()
  if (!onStart || !onUpdate) throw new Error("suggestion popup lifecycle not found")
  return { onStart, onUpdate } as ReturnType<typeof getPopupLifecycleCallbacks>
}

function build(
  candidates: ChannelRefCandidate[] = [],
  popup: ChannelRefPopupState = EMPTY_CHANNEL_REF_STATE,
  onIntent?: () => void,
) {
  const candidatesRef = { current: candidates }
  const popupRef = { current: popup }
  const onIntentRef = { current: onIntent }
  const setPopup = vi.fn()
  const queryRef = { current: "" }
  const ext = buildCommunityChannelRefExtension({ candidatesRef, popupRef, onIntentRef, setPopup, queryRef })
  return { ext, candidatesRef, popupRef, onIntentRef, setPopup, queryRef }
}

describe("toChannelRefCommandProps", () => {
  it("builds the same complete candidate for server-scoped and directory call sites", () => {
    expect(toChannelRefCandidate(
      { id: "srv_1", name: "Alook", discriminator: "5620" },
      { id: "chn_1", name: "general" },
    )).toEqual({
      id: "chn_1",
      name: "general",
      serverId: "srv_1",
      serverName: "Alook",
      serverDiscriminator: "5620",
    })
  })

  it("maps the complete canonical server identity through both insertion paths", () => {
    const item = candidate("chn_1", "general", "srv_1", "Studio")
    expect(toChannelRefCommandProps(item)).toEqual({
      id: "chn_1",
      label: "general",
      serverId: "srv_1",
      serverName: "Studio",
      serverDiscriminator: "0042",
    })
  })
})

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

  it("signals directory demand when slash suggestions are evaluated", () => {
    const onIntent = vi.fn()
    const { ext } = build([], EMPTY_CHANNEL_REF_STATE, onIntent)
    getItemsCallback(ext)({ query: "" })
    expect(onIntent).toHaveBeenCalledTimes(1)
  })

  it("emits one directory intent per suggestion session and resets on exit", () => {
    const onIntent = vi.fn()
    const { ext } = build([], EMPTY_CHANNEL_REF_STATE, onIntent)
    const items = getItemsCallback(ext)
    const onExit = getExitCallback(ext)

    items({ query: "" })
    items({ query: "g" })
    items({ query: "gen" })
    expect(onIntent).toHaveBeenCalledTimes(1)

    onExit()
    items({ query: "" })
    items({ query: "r" })
    expect(onIntent).toHaveBeenCalledTimes(2)
  })
})

describe("buildCommunityChannelRefExtension — popup lifecycle", () => {
  it("passes the live query through onStart/onUpdate and defaults a missing query", () => {
    const items = [candidate("c1", "general")]
    const command = vi.fn()
    const { ext, setPopup } = build(items)
    const { onStart, onUpdate } = getPopupLifecycleCallbacks(ext)

    onStart({ items, query: "gen", command })
    onStart({ items, command })
    expect(setPopup.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ query: "gen" }))
    expect(setPopup.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ query: "" }))

    setPopup.mockClear()
    onUpdate({ items, query: "gene", command })
    onUpdate({ items, command })
    const current = { ...EMPTY_CHANNEL_REF_STATE, items, selectedIndex: 0 }
    const firstUpdate = setPopup.mock.calls[0]?.[0] as (cur: ChannelRefPopupState) => ChannelRefPopupState
    const secondUpdate = setPopup.mock.calls[1]?.[0] as (cur: ChannelRefPopupState) => ChannelRefPopupState
    expect(firstUpdate(current)).toEqual(expect.objectContaining({ query: "gene" }))
    expect(secondUpdate(current)).toEqual(expect.objectContaining({ query: "" }))
  })
})

describe("buildCommunityChannelRefExtension — renderText/renderHTML", () => {
  it("renderText produces /serverName#discriminator/label", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({
        node: { attrs: { id: "chn_abc", serverId: "srv_xyz", serverName: "Studio", serverDiscriminator: "0042", label: "general" } },
      }),
    ).toBe("/Studio#0042/general")
  })

  it("renderText falls back independently per-field — serverName missing falls back to serverId, label missing falls back to id (mixed case, not all-or-nothing)", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    // serverName missing, label present.
    expect(
      renderText({
        node: { attrs: { id: "chn_abc", serverId: "srv_xyz", serverName: null, label: "general" } },
      }),
    ).toBe("/srv_xyz/general")
    // serverName present, label missing.
    expect(
      renderText({
        node: { attrs: { id: "chn_abc", serverId: "srv_xyz", serverName: "Studio", serverDiscriminator: "0042", label: null } },
      }),
    ).toBe("/Studio#0042/chn_abc")
  })

  it("never emits a bare server display name when the discriminator is missing", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({
        node: { attrs: { id: "chn_abc", serverId: "srv_xyz", serverName: "Studio", serverDiscriminator: null, label: "general" } },
      }),
    ).toBe("/srv_xyz/general")
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

  it("renderText falls back to the channel id alone when server is missing but the channel id is present", () => {
    // With independent per-field fallback, a present `id` still lets the
    // channel segment resolve even when both `serverName`/`serverId` are
    // missing — only the server segment drops out.
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({ node: { attrs: { id: "chn_abc", serverId: null, serverName: null, label: null } } }),
    ).toBe("/chn_abc")
  })

  it("renderText emits empty string when nothing at all is present (server AND channel both fully missing)", () => {
    const { ext } = build()
    const { renderText } = getRenderFns(ext)
    expect(
      renderText({
        node: { attrs: { id: null, serverId: null, serverName: null, label: null } },
      }),
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

  it("selecting a candidate via Enter preserves the discriminator via toChannelRefCommandProps", () => {
    const command = vi.fn()
    const items = [candidate("chn_1", "general", "srv_1", "Studio")]
    const { ext, setPopup } = build(items, { items, selectedIndex: 0, command, rect: null })
    const onKeyDown = getKeyDownCallback(ext)
    const enter = { key: "Enter", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: enter })).toBe(true)
    // Regression guard for the name→label mapping bug: passing the raw
    // candidate through as-is would leave `attrs.label` `null` and silently
    // render "/null" in the in-editor chip.
    expect(command).toHaveBeenCalledWith({ id: "chn_1", label: "general", serverId: "srv_1", serverName: "Studio", serverDiscriminator: "0042" })
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
    expect(command).toHaveBeenCalledWith({ id: "chn_1", label: "general", serverId: "srv_1", serverName: "Studio", serverDiscriminator: "0042" })
  })

  it("returns false when there are no items (popup effectively closed)", () => {
    const { ext } = build([], { ...EMPTY_CHANNEL_REF_STATE })
    const onKeyDown = getKeyDownCallback(ext)
    const enter = { key: "Enter", preventDefault: vi.fn(), isComposing: false } as unknown as KeyboardEvent
    expect(onKeyDown({ event: enter })).toBe(false)
  })
})
