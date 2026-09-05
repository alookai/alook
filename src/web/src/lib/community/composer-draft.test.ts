import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  draftStorageKey,
  readComposerDraft,
  writeComposerDraft,
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
    expect(draftStorageKey("account-1", "srv/chan")).toBe("c-replica-v1:account-1:draft:srv/chan")
  })

  it("returns null when no draft is stored", () => {
    expect(readComposerDraft("account-1", "srv/chan")).toBeNull()
  })

  it("round-trips a ProseMirror doc losslessly (pills preserved)", () => {
    writeComposerDraft("account-1", "srv/chan", DOC_WITH_PILL)
    expect(readComposerDraft("account-1", "srv/chan")).toEqual(DOC_WITH_PILL)
  })

  it("round-trips ordered-list start, items, and pills losslessly", () => {
    writeComposerDraft("account-1", "srv/chan", DOC_WITH_ORDERED_LIST_AND_PILLS)
    expect(readComposerDraft("account-1", "srv/chan"))
      .toEqual(DOC_WITH_ORDERED_LIST_AND_PILLS)
  })

  it("persists as JSON under the key", () => {
    writeComposerDraft("account-1", "srv/chan", DOC_WITH_PILL)
    expect(storage["c-replica-v1:account-1:draft:srv/chan"]).toBe(JSON.stringify(DOC_WITH_PILL))
  })

  it("scopes drafts independently per conversation", () => {
    writeComposerDraft("account-1", "srv/a", { type: "doc", content: [{ type: "paragraph" }] })
    writeComposerDraft("account-1", "srv/b", DOC_WITH_PILL)
    expect(readComposerDraft("account-1", "srv/b")).toEqual(DOC_WITH_PILL)
    expect(readComposerDraft("account-1", "srv/a")).not.toEqual(DOC_WITH_PILL)
    expect(readComposerDraft("account-2", "srv/b")).toBeNull()
  })

  it("removes the key when the draft is null (empty editor)", () => {
    writeComposerDraft("account-1", "srv/chan", DOC_WITH_PILL)
    writeComposerDraft("account-1", "srv/chan", null)
    expect(storage["c-replica-v1:account-1:draft:srv/chan"]).toBeUndefined()
    expect(readComposerDraft("account-1", "srv/chan")).toBeNull()
  })

  it("clear removes a stored draft", () => {
    writeComposerDraft("account-1", "srv/chan", DOC_WITH_PILL)
    clearComposerDraft("account-1", "srv/chan")
    expect(readComposerDraft("account-1", "srv/chan")).toBeNull()
  })

  it("returns null on corrupt stored JSON instead of throwing", () => {
    storage["c-replica-v1:account-1:draft:srv/chan"] = "not-json{{{"
    expect(readComposerDraft("account-1", "srv/chan")).toBeNull()
  })

  it("returns null when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined)
    expect(readComposerDraft("account-1", "srv/chan")).toBeNull()
  })
})
