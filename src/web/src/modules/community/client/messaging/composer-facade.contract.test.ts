import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ComponentProps, ComponentRef } from "react"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as facade from "./composer"
import { Composer } from "./composer"
import type { ComposerHandle, ComposerProps } from "./composer"
import {
  Composer as LegacyComposer,
  clipboardFiles as legacyClipboardFiles,
  pendingFilesToSendAttachments as legacyPendingFilesToSendAttachments,
} from "@/components/community/messages/composer"
import type {
  ComposerHandle as LegacyComposerHandle,
  ComposerProps as LegacyComposerProps,
  SendAttachment as LegacySendAttachment,
} from "@/components/community/messages/composer"
import type { SendAttachment } from "@/lib/community/models/message"

const messagesDirectory = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(messagesDirectory, "../../../../..")
const readWeb = (path: string) =>
  readFileSync(resolve(webRoot, path), "utf8")

describe("Composer public facade", () => {
  it("keeps the exact props and five-method forwarded handle", () => {
    expectTypeOf<ComponentProps<typeof Composer>>().toEqualTypeOf<ComposerProps>()
    expectTypeOf<ComponentRef<typeof Composer>>().toEqualTypeOf<ComposerHandle>()
    expectTypeOf<typeof LegacyComposer>().toEqualTypeOf<typeof Composer>()
    expectTypeOf<LegacyComposerProps>().toEqualTypeOf<ComposerProps>()
    expectTypeOf<LegacyComposerHandle>().toEqualTypeOf<ComposerHandle>()
    expectTypeOf<LegacySendAttachment>().toEqualTypeOf<SendAttachment>()
    expect(legacyClipboardFiles).toBe(facade.clipboardFiles)
    expect(legacyPendingFilesToSendAttachments).toBe(
      facade.pendingFilesToSendAttachments,
    )
    expectTypeOf<keyof ComposerHandle>().toEqualTypeOf<
      | "focusEditor"
      | "submitNow"
      | "resetAfterSubmit"
      | "isEmpty"
      | "openFilePicker"
    >()
  })

  it("keeps the seven-export module facade and controller-owned render path", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "Composer",
      "ComposerSkeleton",
      "clipboardFiles",
      "pendingFilesToSendAttachments",
    ])
    const source = readWeb("src/modules/community/client/messaging/composer.tsx")
    const namesFromBlocks = (pattern: RegExp) =>
      [...source.matchAll(pattern)].flatMap((match) =>
        match[1]
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[1] ?? part.trim())
          .filter(Boolean),
      )
    const typeExports = namesFromBlocks(/export\s+type\s*\{([^}]*)\}/gs)
    const valueExports = [
      ...namesFromBlocks(/export\s*\{([^}]*)\}/gs),
      ...[...source.matchAll(/export\s+(?:const|function|class)\s+(\w+)/g)].map(
        (match) => match[1],
      ),
    ]
    expect(new Set(typeExports)).toEqual(
      new Set(["ComposerHandle", "ComposerProps", "SendAttachment"]),
    )
    expect(new Set(valueExports)).toEqual(
      new Set([
        "Composer",
        "ComposerSkeleton",
        "pendingFilesToSendAttachments",
        "clipboardFiles",
      ]),
    )
    expect(source).not.toMatch(/export\s+(?:default|\*)/)
    expect(source).toContain("useComposerController(props, ref)")
    expect(source).toContain("<ComposerView {...viewProps} />")
    expect(source).not.toContain("useEditor(")
    expect(source).not.toContain("useFileAttachments(")
  })

  it("keeps the legacy file as a re-export-only compatibility facade", () => {
    const source = readWeb("src/components/community/messages/composer.tsx")
    expect(source).toContain(
      'from "@/modules/community/client/messaging/composer"',
    )
    expect(source).toMatch(/^export\s+\{/)
    expect(source).not.toMatch(/\b(import|function|const|let|class|use[A-Z]\w*)\b/)
    expect(source).not.toMatch(/<\w|=>/)
  })

  it("keeps every direct importer on the facade and out of internals", () => {
    const importers = [
      "src/app/c/me/[dmId]/page.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/channel-route.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/messages/create-forum-thread.tsx",
      "src/modules/community/client/messaging/message-channel-controller.tsx",
      "src/components/community/channels/thread-channel-surface.test.ts",
    ]
    for (const importer of importers) {
      const source = readWeb(importer)
      expect(source).toMatch(/(?:from|import\()\s*["'][^"']*\/composer["']/)
      expect(source).not.toMatch(
        /composer-(?:types|file-utils|view|suggestion-popups)|use-composer-(?:controller|suggestions)/,
      )
    }
  })

  it("keeps every production owner below 400 lines without an internal barrel", () => {
    const owners = [
      "composer.tsx",
      "composer-types.ts",
      "composer-file-utils.ts",
      "use-composer-controller.ts",
      "use-composer-suggestions.ts",
      "composer-suggestion-popups.tsx",
      "composer-view.tsx",
    ]
    for (const owner of owners) {
      const path = owner === "composer.tsx"
        ? `src/modules/community/client/messaging/${owner}`
        : `src/modules/community/client/messaging/internal/${owner}`
      const source = readWeb(path)
      expect(source.split("\n").length, owner).toBeLessThan(400)
    }
    expect(
      existsSync(resolve(webRoot, "src/modules/community/client/messaging/internal/index.ts")),
    ).toBe(false)
  })
})
