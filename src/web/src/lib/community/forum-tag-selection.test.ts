import { describe, expect, it, vi } from "vitest"
import { forumTagFromUrl, readForumTagSelection, validateForumTagSelection, writeForumTagSelection } from "./forum-tag-selection"

describe("forum tag selection", () => {
  it("distinguishes an absent URL selection from explicit All and normalizes a tag", () => {
    expect(forumTagFromUrl(null)).toBeNull()
    expect(forumTagFromUrl(undefined)).toBeNull()
    expect(forumTagFromUrl("")).toBe("All")
    expect(forumTagFromUrl(" BUG ")).toBe("bug")
    expect(forumTagFromUrl("all")).toBe("all")
  })
  it("defaults to All and scopes persisted selections by channel", () => {
    const getItem = vi.fn((key: string) => key.endsWith("forum-a") ? "bug" : null)
    expect(readForumTagSelection({ getItem }, "forum-a")).toBe("bug")
    expect(readForumTagSelection({ getItem }, "forum-b")).toBe("All")
  })

  it("stores a selected tag and removes All", () => {
    const storage = { setItem: vi.fn(), removeItem: vi.fn() }
    writeForumTagSelection(storage, "forum-a", "bug")
    expect(storage.setItem).toHaveBeenCalledWith("alook:forum-tag:forum-a", "bug")
    writeForumTagSelection(storage, "forum-a", "All")
    expect(storage.removeItem).toHaveBeenCalledWith("alook:forum-tag:forum-a")
  })

  it("keeps a restored tag only after it exists in the scoped distinct set", () => {
    expect(validateForumTagSelection("bug", ["bug", "feature"])).toBe("bug")
    expect(validateForumTagSelection("gone", ["bug", "feature"])).toBe("All")
  })

  it("retains an available Archived selection", () => {
    expect(validateForumTagSelection("archived", ["archived", "bug"])).toBe("archived")
  })
})
