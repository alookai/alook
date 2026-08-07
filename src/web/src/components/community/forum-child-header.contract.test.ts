import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("forum child header wiring", () => {
  it("keeps opener/list edit affordances absent and gates title editing to the creator", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/components/community/channel-route.tsx"), "utf8")
    const forumView = fs.readFileSync(path.join(process.cwd(), "src/components/community/forum-view.tsx"), "utf8")

    expect(route).toContain("parentMessageId && !parentIsForum")
    expect(route).toContain("currentChannelMeta?.creatorId === currentUser.id")
    expect(route).toContain("titleRename: parentIsForum")
    expect(route).toContain("messageId: parentMessageId")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
