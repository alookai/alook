import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import type { Msg } from "@/lib/community/models/message"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { installMessageScrollFixture, resize, restoreMessageScrollFixture, scrollFixture } from "@/test/message-scroll-fixture"
import { act, render } from "@/test/react-dom-harness"
import { MessageList } from "./message-list"

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate")
const effects: Array<{ target: Element; frames: Keyframe[] }> = []

beforeEach(() => {
  effects.length = 0
  installMessageScrollFixture()
  scrollFixture.height = 1000
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: function(this: Element, frames: Keyframe[]) {
    effects.push({ target: this, frames })
    return { cancel: vi.fn(), finished: Promise.resolve() }
  } })
})

afterEach(() => {
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate)
  else Reflect.deleteProperty(Element.prototype, "animate")
  restoreMessageScrollFixture()
})

function message(id: string, seq: number | undefined, content: string, owner = "peer"): Msg {
  return { id, seq, content, type: "chat", authorId: owner, createdAt: new Date((seq ?? 4) * 600_000).toISOString() }
}

it("animates arrivals and changed reactions without replaying history or a confirmed send", async () => {
  const owner = await createCommunityQueryOwner("viewer")
  const existing = {
    ...message("existing", 2, "Keep this message."),
    reactions: [{ emoji: "👀", count: 1, me: false, userIds: ["peer"] }],
  }
  const old = message("older", 1, "Older history.")
  const peer = message("new", 3, "New message.")
  const local = { ...message("sending", undefined, "My message.", "viewer"), clientNonce: "outbox-nonce" }
  const entry = {}
  const scene = (messages: Msg[]) => (
    <CommunityTestProvider {...owner}>
      <CommunityPreviewNavigation value={true}>
        <MessageList channel="general" positionEntry={entry} viewerUserId="viewer" messages={messages} onOpenThread={() => {}} />
      </CommunityPreviewNavigation>
    </CommunityTestProvider>
  )
  const matchMedia = window.matchMedia.bind(window)
  const preference = vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const result = matchMedia(query)
    return query === "(prefers-reduced-motion: reduce)" ? { ...result, matches: false } : result
  })
  const view = render(scene([existing]))
  const body = (id: string) => view.container.querySelector(`[data-msg-id="${id}"] [data-community-message-body]`)
  const chips = () => [...view.container.querySelectorAll(`[data-msg-id="${existing.id}"] [data-message-reaction]`)]
  const chip = (emoji: string) => chips().find(element => element.getAttribute("data-message-reaction") === emoji)
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    const originalBody = body(existing.id)
    expect(originalBody).toHaveTextContent("Keep this message.")
    const unchanged = chip("👀")
    expect(chips().map(element => element.getAttribute("data-message-reaction"))).toEqual(["👀"])
    expect(effects).toEqual([])

    view.rerender(scene([old, existing]))
    resize()
    expect(body(old.id)).toHaveTextContent("Older history.")
    expect(effects).toEqual([])

    view.rerender(scene([old, existing, peer]))
    resize()
    expect(body(peer.id)).toHaveTextContent("New message.")
    expect(effects.map(effect => effect.target.closest("[data-msg-id]")?.getAttribute("data-msg-id"))).toEqual([peer.id])
    expect(effects[0].frames[0]).toMatchObject({ opacity: 0, translate: "0 4px" })
    effects.length = 0

    const newReaction = { emoji: "🎉", count: 1, me: true, userIds: ["viewer"] }
    const reacted = { ...existing, reactions: [...existing.reactions, newReaction] }
    view.rerender(scene([old, reacted, peer]))
    expect(body(existing.id)).toBe(originalBody)
    expect(chip("👀")).toBe(unchanged)
    expect(chip("🎉")).toHaveAttribute("aria-pressed", "true")
    expect(effects.map(effect => effect.target)).toEqual([chip("🎉")])
    effects.length = 0

    const reactionChip = chip("🎉")
    const counted = { ...reacted, reactions: [...existing.reactions, { ...newReaction, count: 2, userIds: ["viewer", "peer"] }] }
    view.rerender(scene([old, counted, peer]))
    expect(chip("🎉")).toBe(reactionChip)
    expect(chip("🎉")).toHaveAccessibleName(/2 reactions/)
    expect(effects.map(effect => effect.target)).toEqual([reactionChip])
    effects.length = 0

    view.rerender(scene([old, counted, peer, local]))
    resize()
    const pending = body(local.id)
    expect(pending).toHaveTextContent("My message.")
    expect(effects.map(effect => effect.target.closest("[data-msg-id]")?.getAttribute("data-msg-id"))).toEqual([local.id])
    effects.length = 0

    view.rerender(scene([old, counted, peer, { ...local, id: "confirmed", seq: 4 }]))
    resize()
    expect(body("confirmed")).toBe(pending)
    expect(body(peer.id)).toBeInTheDocument()
    expect(effects).toEqual([])
  } finally {
    view.unmount()
    preference.mockRestore()
    owner.client.clear()
  }
})
