import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

describe("forum child header wiring", () => {
  it("keeps opener/list edit affordances absent and gates title editing to the creator", () => {
    const route = fs.readFileSync(path.join(process.cwd(), "src/components/community/channel-route.tsx"), "utf8")
    const surface = fs.readFileSync(path.join(process.cwd(), "src/components/community/thread-channel-surface.tsx"), "utf8")
    const forumView = fs.readFileSync(path.join(process.cwd(), "src/components/community/forum-view.tsx"), "utf8")

    expect(route).toContain("<ThreadChannelSurface")
    expect(surface).toContain("parentMessageId && !parentIsForum")
    expect(surface).toContain("childCreatorId === viewer.id")
    expect(surface).toContain("titleRename: parentIsForum")
    expect(surface).toContain("messageId: parentMessageId")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
