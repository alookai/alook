import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const componentDirectory = path.dirname(fileURLToPath(import.meta.url))

describe("forum child header wiring", () => {
  it("keeps opener/list edit affordances absent and gates title editing to the creator", () => {
    const route = fs.readFileSync(path.join(componentDirectory, "../../../modules/community/client/channel/internal/channel-controller.tsx"), "utf8")
    const routeView = fs.readFileSync(path.join(componentDirectory, "../../../modules/community/client/channel/internal/channel-view.tsx"), "utf8")
    const surface = fs.readFileSync(path.join(componentDirectory, "thread-channel-surface.tsx"), "utf8")
    const forumView = fs.readFileSync(path.join(componentDirectory, "forum-view.tsx"), "utf8")

    expect(route).toContain("thread={{")
    expect(routeView).toContain("<ThreadChannelSurface")
    expect(surface).toContain("parentMessageId && !parentIsForum")
    expect(surface).toContain("childCreatorId === viewer.id")
    expect(surface).toContain("titleRename: parentIsForum")
    expect(surface).toContain("messageId: parentMessageId")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
