import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  draftStorageKey,
  readComposerDraft,
  writeComposerDraft,
  clearComposerDraft,
} from "./composer-draft"

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

  it("returns empty string when no draft is stored", () => {
    expect(readComposerDraft("srv/chan")).toBe("")
  })

  it("round-trips written text", () => {
    writeComposerDraft("srv/chan", "hello\n\nworld")
    expect(readComposerDraft("srv/chan")).toBe("hello\n\nworld")
  })

  it("scopes drafts independently per conversation", () => {
    writeComposerDraft("srv/a", "draft A")
    writeComposerDraft("srv/b", "draft B")
    expect(readComposerDraft("srv/a")).toBe("draft A")
    expect(readComposerDraft("srv/b")).toBe("draft B")
  })

  it("removes the key when the draft is empty or whitespace-only", () => {
    writeComposerDraft("srv/chan", "something")
    writeComposerDraft("srv/chan", "   \n  ")
    expect(storage["c-composer-draft:srv/chan"]).toBeUndefined()
    expect(readComposerDraft("srv/chan")).toBe("")
  })

  it("clear removes a stored draft", () => {
    writeComposerDraft("srv/chan", "text")
    clearComposerDraft("srv/chan")
    expect(readComposerDraft("srv/chan")).toBe("")
  })

  it("returns empty string when window is undefined (SSR)", () => {
    vi.stubGlobal("window", undefined)
    expect(readComposerDraft("srv/chan")).toBe("")
  })
})
