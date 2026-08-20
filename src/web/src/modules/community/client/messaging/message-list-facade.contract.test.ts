import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ComponentProps, ComponentRef, ReactNode } from "react"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as facade from "./message-list"
import type { FileAttachment, ImagePreview, Msg } from "@/lib/community/models/message"
import type { OpenProfile } from "@/components/community/social/profile-types"

type ExpectedMessageListProps = {
  channel: string
  messages: Msg[]
  loading?: boolean
  pinnedIds?: Set<string>
  newDividerBefore?: string
  typingUsers?: string[]
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReaction?: (id: string, emoji: string) => void
  onReact?: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  onPin?: (id: string) => void
  onMark?: (id: string) => void
  onCreateThread?: (id: string) => void
  onCopy?: (id: string) => void
  onEdit?: (id: string) => void
  onRetry?: (id: string) => void
  onDismiss?: (id: string) => void
  onPreviewImage?: (image: ImagePreview) => void
  onPreviewAttachment?: (attachment: FileAttachment) => void
  onDownloadFile?: (url: string, name: string) => void
  resolveUserName?: (userId: string) => string
  scrollToMessageId?: string | null
  hero?: ReactNode
  variant?: "channel" | "dm"
  onScrollRoot?: (element: HTMLDivElement | null) => void
  viewerUserId?: string
  initialScrollReady?: boolean
  onScrollTargetConsumed?: (id: string) => void
  hasMore?: boolean
  isFetchingOlder?: boolean
  onLoadOlder?: () => void
  hasMoreNewer?: boolean
  isFetchingNewer?: boolean
  onLoadNewer?: () => void
  onJumpToPresent?: () => void
  presentVersion?: number
  unreadCount?: number
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("MessageList facade contract", () => {
  it("keeps the exact one-value module surface and applies defaults in the owner", () => {
    expect(Object.keys(facade)).toEqual(["MessageList"])
    expectTypeOf<ComponentProps<typeof facade.MessageList>>()
      .toEqualTypeOf<ExpectedMessageListProps>()
    expectTypeOf<ExpectedMessageListProps>()
      .toEqualTypeOf<ComponentProps<typeof facade.MessageList>>()
    expectTypeOf<ComponentRef<typeof facade.MessageList>>().toEqualTypeOf<never>()
    const text = source("src/modules/community/client/messaging/message-list.tsx")
    expect(text).toContain('variant = "channel"')
    expect(text).toContain("initialScrollReady = true")
    expect(text).toContain("useMessageListController(resolvedProps)")
    expect(text).toContain("return renderMessageListView(resolvedProps, controller, () => (")
    expect(text).toContain("<VirtualRows")
    expect(text).toContain("items={controller.items}")
    expect(text).toContain("virtualizer={controller.virtualizer}")
    expect(text).toContain("itemKey={(item) => item.key}")
    expect(text).toContain(
      "renderItem={(item) => renderMessageListRow(item, resolvedProps, controller)}",
    )
    expect(text).not.toMatch(/<MessageListView\b|createElement\(MessageListView/)
    expect(text).not.toMatch(/forwardRef|useImperativeHandle/)
  })

  it("keeps the legacy file as a re-export-only facade", () => {
    const text = source("src/components/community/messages/message-list.tsx")
    expect(text.trim()).toBe(
      'export { MessageList } from "@/modules/community/client/messaging/message-list"',
    )
  })

  it("keeps all production consumers on the original path", () => {
    const importers = [
      "src/app/c/channels/[serverId]/page.tsx",
      "src/app/c/me/[dmId]/page.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/channel-route.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
    ]
    for (const path of importers) {
      const text = source(path)
      expect(text).toMatch(/messages\/message-list["']/)
      expect(text).not.toMatch(/message-list-(types|controller|view|row)/)
    }
  })
})
