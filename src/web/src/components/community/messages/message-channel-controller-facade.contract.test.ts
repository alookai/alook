import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as facade from "./message-channel-controller"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("MessageChannelController facade boundaries", () => {
  it("exposes the public component without internal runtime exports", () => {
    expect(Object.keys(facade)).toEqual(["MessageChannelController"])
  })

  it("keeps production and test consumers on the original path", () => {
    const importers = [
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/channels/thread-channel-surface.dom.test.ts",
      "src/components/community/channels/text-channel-surface.dom.test.ts",
    ]
    for (const path of importers) {
      const text = source(path)
      expect(text).toMatch(/message-channel-controller["']/)
      expect(text).not.toMatch(/message-channel-controller-(types|state|actions|send|view)/)
    }
  })

  it("keeps action and send helpers hook-free", () => {
    for (const helper of ["actions", "send"]) {
      expect(source(`src/components/community/messages/message-channel-controller-${helper}.ts`))
        .not.toMatch(/\buse[A-Z][A-Za-z]+\(/)
    }
  })
})
