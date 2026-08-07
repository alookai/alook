import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("forum child header wiring", () => {
  it("keeps opener/list edit affordances absent and gates title editing to the creator", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/c/channels/[serverId]/[channelId]/page.tsx"), "utf8")
    const forumView = fs.readFileSync(path.join(process.cwd(), "src/components/community/forum-view.tsx"), "utf8")

    expect(page).toContain("parentMessageId && !parentIsForum")
    expect(page).toContain("currentChannelMeta?.creatorId === currentUser.id")
    expect(page).toContain("titleRename: parentIsForum")
    expect(page).toContain("messageId: parentMessageId")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
