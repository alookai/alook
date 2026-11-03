import staticContractInput0 from "./channel-route.tsx?raw"
import staticContractInput1 from "./thread-channel-surface.tsx?raw"
import staticContractInput2 from "./forum-view.tsx?raw"
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const componentDirectory = path.dirname(fileURLToPath(import.meta.url))

describe("forum child header wiring", () => {
  it("keeps opener/list edit affordances absent and limits renaming to ordinary threads", () => {
    const route = staticContractInput0
    const surface = staticContractInput1
    const forumView = staticContractInput2

    expect(route).toContain("<ThreadChannelSurface")
    expect(surface).toContain("parentMessageId && !parentIsForum")
    expect(surface).toContain("!parentIsForum && canRenameThread")
    expect(forumView).not.toContain("Edit post")
    expect(forumView).not.toMatch(/\bonEditPost(?:\?|\s|=)/)
  })
})
