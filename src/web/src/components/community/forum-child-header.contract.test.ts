import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const componentDirectory = path.dirname(fileURLToPath(import.meta.url))

describe("forum child header wiring", () => {
  it("keeps list edit affordances absent, renders opener context, and gates title editing to the creator", () => {
    const route = fs.readFileSync(path.join(componentDirectory, "channel-route.tsx"), "utf8")
    const surface = fs.readFileSync(path.join(componentDirectory, "thread-channel-surface.tsx"), "utf8")
    const forumView = fs.readFileSync(path.join(componentDirectory, "forum-view.tsx"), "utf8")

    expect(route).toContain("<ThreadChannelSurface")
    expect(surface).toContain("const opener = parentMessageId ?")
    expect(surface).toContain("parentChannelId && !parentIsForum")
    expect(surface).toContain("childCreatorId === viewer.id")
    expect(surface).toContain("titleRename: parentIsForum")
    expect(surface).toContain("messageId: parentMessageId")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
