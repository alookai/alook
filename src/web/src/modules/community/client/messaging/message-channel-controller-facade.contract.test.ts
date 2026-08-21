import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ComponentProps, ComponentRef, ReactNode } from "react"
import type { MentionType } from "@alook/shared"
import { describe, expect, expectTypeOf, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useController: vi.fn(),
  renderController: vi.fn(),
}))

vi.mock("./internal/message-channel-controller-state", () => ({
  useMessageChannelController: (...args: unknown[]) =>
    mocks.useController(...args),
}))
vi.mock("./internal/message-channel-controller-view", () => ({
  renderMessageChannelController: (...args: unknown[]) =>
    mocks.renderController(...args),
}))
import * as facade from "./message-channel-controller"
import type { MessageChannelControllerValue as FacadeControllerValue } from "./message-channel-controller"
import type {
  FileAttachment,
  ImagePreview,
  Msg,
  SendAttachment,
} from "@/lib/community/models/message"
import type { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

type ExpectedReplyTarget = { id: string; authorName: string; text: string }
type ExpectedContextTarget = {
  serverId: string
  channelId: string
  label: string
  seq: number
}
type ExpectedMessageActions = {
  onToggleReaction: (id: string, emoji: string) => void
  onReact: (id: string, emoji: string) => void
  onReply: (id: string) => void
  onPin: (id: string) => void
  onMark: (id: string) => void
  onCreateThread: (id: string) => Promise<void>
  onCopy: (id: string) => void
  onEdit: (id: string) => void
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  onPreviewImage: (image: ImagePreview) => void
  onPreviewAttachment: (attachment: FileAttachment) => void
  onDownloadFile: (url: string, name: string) => void
}
type ExpectedControllerValue = {
  feed: ReturnType<typeof useChannelMessageFeed>
  pinnedIds: Set<string>
  replyTo: ExpectedReplyTarget | null
  setReplyTo: (reply: ExpectedReplyTarget | null) => void
  searchQuery: string
  searchResults: Msg[]
  search: (query: string) => void
  scrollTargetId: string | null
  setScrollTargetId: (targetId: string | null) => void
  consumeScrollTarget: (targetId: string) => void
  contextTarget: ExpectedContextTarget | null
  setContextTarget: (target: ExpectedContextTarget | null) => void
  openContextSeq: (seq: number) => void
  onSheetReply: (target: ExpectedReplyTarget) => void
  jumpToSeq: (seq: number) => void
  messageActions: ExpectedMessageActions
  threadActions: Omit<ExpectedMessageActions, "onCreateThread"> & { onCreateThread: undefined }
  acceptMessage: (
    markdown: string,
    attachments?: SendAttachment[],
    mentionType?: MentionType,
  ) => boolean
  handleTyping: () => void
  typingUsers: string[]
}
type ExpectedControllerProps = {
  channelId: string
  serverId: string
  serverParam: string
  channelName: string
  forumParentChannelId?: string
  viewer: { id: string; name: string; avatar: string }
  anchorMessageId: string | null
  feed: ReturnType<typeof useChannelMessageFeed>
  uiHandlers: {
    navigate?: (serverId: string, channelId: string) => void
    previewImage?: (image: ImagePreview) => void
    previewAttachment?: (attachment: FileAttachment) => void
  }
  onOpenThread: (threadId: string) => void
  onOpenPinned: () => void
  resolveUserName: (userId: string) => string
  children: (controller: ExpectedControllerValue) => ReactNode
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("MessageChannelController facade contract", () => {
  it("keeps the exact runtime export and a direct non-component render call", () => {
    expect(Object.keys(facade)).toEqual(["MessageChannelController"])
    expectTypeOf<ComponentProps<typeof facade.MessageChannelController>>()
      .toEqualTypeOf<ExpectedControllerProps>()
    expectTypeOf<ExpectedControllerProps>()
      .toEqualTypeOf<ComponentProps<typeof facade.MessageChannelController>>()
    expectTypeOf<FacadeControllerValue>().toEqualTypeOf<ExpectedControllerValue>()
    expectTypeOf<ExpectedControllerValue>().toEqualTypeOf<FacadeControllerValue>()
    expectTypeOf<ComponentRef<typeof facade.MessageChannelController>>().toEqualTypeOf<never>()
    const text = source("src/modules/community/client/messaging/message-channel-controller.tsx")
    expect(text).toContain("useMessageChannelController(props)")
    expect(text).toContain("return renderMessageChannelController(children, value)")
    expect(text).not.toMatch(/<MessageChannelControllerView\b|createElement\(MessageChannelControllerView/)
    expect(text).not.toMatch(/forwardRef|useImperativeHandle/)

    const children = vi.fn()
    const props = { children } as ComponentProps<
      typeof facade.MessageChannelController
    >
    const value = { feed: "controller-value" }
    mocks.useController.mockReturnValue(value)
    mocks.renderController.mockReturnValue("rendered-controller")
    expect(facade.MessageChannelController(props)).toBe("rendered-controller")
    expect(mocks.useController).toHaveBeenCalledWith({})
    expect(mocks.renderController).toHaveBeenCalledWith(children, value)
  })

  it("removes the legacy compatibility facade", () => {
    expect(existsSync(resolve(webRoot, "src/components/community/messages/message-channel-controller.tsx"))).toBe(false)
  })

  it("keeps production and test consumers on the stable messaging entry", () => {
    const importers = [
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/thread-channel-surface.test.ts",
      "src/modules/community/client/channel/internal/text-channel-controller.tsx",
    ]
    for (const path of importers) {
      const text = source(path)
      expect(text).toMatch(/(?:modules\/community\/client\/messaging|\.\.\/\.\.\/messaging)["']/)
      expect(text).not.toMatch(/message-channel-controller-(types|state|actions|send|view)/)
    }
  })

  it("keeps hook wiring in one owner and pure helpers hook-free", () => {
    const state = source("src/modules/community/client/messaging/internal/message-channel-controller-state.ts")
    const body = state.slice(state.indexOf("export function useMessageChannelController"))
    const actions = source("src/modules/community/client/messaging/internal/message-channel-controller-actions.ts")
    const send = source("src/modules/community/client/messaging/internal/message-channel-controller-send.ts")
    const orderedHooks = [
      "const router = useRouter()",
      "const searchParams = useSearchParams()",
      "const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)",
      "const [searchQuery, setSearchQuery] = useState(\"\")",
      "const [searchResults, setSearchResults] = useState<Msg[]>([])",
      "const [scrollTargetId, setScrollTargetId] = useState<string | null>(anchorMessageId)",
      "const [contextTarget, setContextTarget] = useState<MessageContextTarget | null>(null)",
      "useSendMessage()",
      "useToggleReactionApi()",
      "usePinMessage()",
      "useUnpinMessage()",
      "useToggleMark()",
      "useEditMessage()",
      "useCreateThread()",
      "useUploadFile()",
      "useTypingUsersForScope(`ch:${channelId}`)",
      "useTypingNamesForScope(`ch:${channelId}`)",
    ]
    let cursor = -1
    for (const token of orderedHooks) {
      const position = body.indexOf(token, cursor + 1)
      expect(position, token).toBeGreaterThan(cursor)
      cursor = position
    }
    expect(body.match(/\buseState(?:<[^>]+>)?\(/g)).toHaveLength(5)
    expect(actions).not.toMatch(/\buse[A-Z][A-Za-z]+\(/)
    expect(send).not.toMatch(/\buse[A-Z][A-Za-z]+\(/)
  })
})
