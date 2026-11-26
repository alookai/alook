import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  draftStorageKey,
  readComposerDraft,
  writeComposerDraft,
  scheduleComposerDraftWrite,
  flushComposerDraft,
  clearComposerDraft,
} from "./composer-draft"

// A minimal ProseMirror-shaped doc with a mention pill node, to prove the
// draft round-trips the structure (not just plain text) — this is the pill
// regression the JSON switch fixes.
const DOC_WITH_PILL = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "hey " },
        { type: "mention", attrs: { id: "u1", label: "Alice#0001" } },
        { type: "text", text: " see " },
        { type: "channelRef", attrs: { id: "c1", label: "general", serverId: "s1", serverName: "demo" } },
      ],
    },
  ],
}

const DOC_WITH_ORDERED_LIST_AND_PILLS = {
  type: "doc",
  content: [{
    type: "orderedList",
    attrs: { start: 42, type: null },
    content: [
      {
        type: "listItem",
        content: [{
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "u1", label: "Alice#0001" } },
            { type: "text", text: " see " },
            {
              type: "channelRef",
              attrs: {
                id: "c1",
                label: "general",
                serverId: "s1",
                serverName: "demo",
              },
            },
          ],
        }],
      },
      {
        type: "listItem",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: "second" }],
        }],
      },
    ],
  }],
}

describe("composer-draft", () => {
  let storage: Record<string, string>

  beforeEach(() => {
    storage = {}
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete storage[key]
      }),
    })
  })

  it("namespaces the key under the composer-draft prefix", () => {
    expect(draftStorageKey("srv/chan")).toBe("c-composer-draft:srv/chan")
  })

  it("returns null when no draft is stored", () => {
    expect(readComposerDraft("srv/chan")).toBeNull()
  })

  it("round-trips a ProseMirror doc losslessly (pills preserved)", () => {
    writeComposerDraft("srv/chan", DOC_WITH_PILL)
    expect(readComposerDraft("srv/chan")).toEqual(DOC_WITH_PILL)
  })

  it("round-trips ordered-list start, items, and pills losslessly", () => {
    writeComposerDraft("srv/chan", DOC_WITH_ORDERED_LIST_AND_PILLS)
    expect(readComposerDraft("srv/chan"))
      .toEqual(DOC_WITH_ORDERED_LIST_AND_PILLS)
  })

  it("persists as JSON under the key", () => {
    writeComposerDraft("srv/chan", DOC_WITH_PILL)
    expect(storage["c-composer-draft:srv/chan"]).toBe(JSON.stringify(DOC_WITH_PILL))
  })

  it("scopes drafts independently per conversation", () => {
    writeComposerDraft("srv/a", { type: "doc", content: [{ type: "paragraph" }] })
    writeComposerDraft("srv/b", DOC_WITH_PILL)
    expect(readComposerDraft("srv/b")).toEqual(DOC_WITH_PILL)
    expect(readComposerDraft("srv/a")).not.toEqual(DOC_WITH_PILL)
  })

  it("removes the key when the draft is null (empty editor)", () => {
    writeComposerDraft("srv/chan", DOC_WITH_PILL)
    writeComposerDraft("srv/chan", null)
    expect(storage["c-composer-draft:srv/chan"]).toBeUndefined()
    expect(readComposerDraft("srv/chan")).toBeNull()
  })

  it("clear removes a stored draft", () => {
    writeComposerDraft("srv/chan", DOC_WITH_PILL)
    clearComposerDraft("srv/chan")
    expect(readComposerDraft("srv/chan")).toBeNull()
  })

  it("returns null on corrupt stored JSON instead of throwing", () => {
    storage["c-composer-draft:srv/chan"] = "not-json{{{"
    expect(readComposerDraft("srv/chan")).toBeNull()
  })

  it("returns null when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined)
    expect(readComposerDraft("srv/chan")).toBeNull()
  })

  it("coalesces rapid scheduled draft updates into a single storage write while reading the latest pending doc synchronously", () => {
    vi.useFakeTimers()
    try {
      const setItem = localStorage.setItem as ReturnType<typeof vi.fn>
      setItem.mockClear()
      for (let i = 1; i <= 50; i += 1) {
        scheduleComposerDraftWrite("srv/rapid", {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: `draft-${i}` }] }],
        })
      }
      expect(setItem).not.toHaveBeenCalled()
      expect(readComposerDraft("srv/rapid")).toEqual({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "draft-50" }] }],
      })

      vi.advanceTimersByTime(300)
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(storage["c-composer-draft:srv/rapid"]).toContain("draft-50")

      scheduleComposerDraftWrite("srv/rapid", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "flushed" }] }],
      })
      expect(setItem).toHaveBeenCalledTimes(1)
      flushComposerDraft("srv/rapid")
      expect(setItem).toHaveBeenCalledTimes(2)
      expect(storage["c-composer-draft:srv/rapid"]).toContain("flushed")
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushes pending scheduled drafts on beforeunload, pagehide, and hidden visibilitychange and removes listeners once empty", () => {
    vi.useFakeTimers()
    const windowListeners = new Map<string, Set<EventListener>>()
    const documentListeners = new Map<string, Set<EventListener>>()
    let visibilityState: DocumentVisibilityState = "visible"
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const set = windowListeners.get(type) ?? new Set<EventListener>()
        set.add(listener)
        windowListeners.set(type, set)
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        windowListeners.get(type)?.delete(listener)
      }),
    })
    vi.stubGlobal("document", {
      get visibilityState() { return visibilityState },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const set = documentListeners.get(type) ?? new Set<EventListener>()
        set.add(listener)
        documentListeners.set(type, set)
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        documentListeners.get(type)?.delete(listener)
      }),
    })
    try {
      scheduleComposerDraftWrite("srv/reload", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "before-reload" }] }],
      })
      expect(windowListeners.get("beforeunload")?.size).toBe(1)
      expect(windowListeners.get("pagehide")?.size).toBe(1)
      expect(documentListeners.get("visibilitychange")?.size).toBe(1)
      expect(storage["c-composer-draft:srv/reload"]).toBeUndefined()

      for (const listener of [...(windowListeners.get("beforeunload") ?? [])]) listener({} as Event)
      expect(storage["c-composer-draft:srv/reload"]).toContain("before-reload")
      expect(windowListeners.get("beforeunload")?.size).toBe(0)
      expect(windowListeners.get("pagehide")?.size).toBe(0)
      expect(documentListeners.get("visibilitychange")?.size).toBe(0)

      scheduleComposerDraftWrite("srv/nav", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "before-pagehide" }] }],
      })
      for (const listener of [...(windowListeners.get("pagehide") ?? [])]) listener({} as Event)
      expect(storage["c-composer-draft:srv/nav"]).toContain("before-pagehide")
      expect(windowListeners.get("pagehide")?.size).toBe(0)

      scheduleComposerDraftWrite("srv/hide", {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "before-hide" }] }],
      })
      visibilityState = "hidden"
      for (const listener of [...(documentListeners.get("visibilitychange") ?? [])]) listener({} as Event)
      expect(storage["c-composer-draft:srv/hide"]).toContain("before-hide")
      expect(documentListeners.get("visibilitychange")?.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
