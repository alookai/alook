import React from "react"
import { describe, expect, it, vi } from "vitest"
import { CommunityPanelSheet } from "@/components/community/shell/community-panel-sheet"
import { MessageContextSheet } from "@/components/community/messages/message-context-sheet"
import { ChannelHeader } from "../channel-header"
import { ChannelShell } from "../channel-shell"
import { Composer, MessageList, type MessageChannelControllerValue } from "../../messaging"
import { TextChannelView, type TextChannelViewProps } from "./text-channel-view"

function findElement(node: React.ReactNode, type: unknown): React.ReactElement<Record<string, any>> | null {
  if (!React.isValidElement(node)) return null
  if (node.type === type) return node as React.ReactElement<Record<string, any>>
  const children = (node.props as { children?: React.ReactNode }).children
  for (const child of React.Children.toArray(children)) {
    const found = findElement(child, type)
    if (found) return found
  }
  return null
}

function controller(overrides: Partial<MessageChannelControllerValue> = {}): MessageChannelControllerValue {
  const feed = {
    messages: [], isLoading: false, newDividerBefore: undefined,
    setScrollRootEl: vi.fn(), readSnapshotFetching: false, anchorInCache: true,
    hasMoreOlder: false, isFetchingOlder: false, fetchOlder: vi.fn(),
    hasMoreNewer: false, isFetchingNewer: false, fetchNewer: vi.fn(),
    jumpToPresent: vi.fn(), presentVersion: 0, unreadCount: 0,
    pinned: [], pinnedLoading: false, threads: [], threadsLoading: false,
  }
  return {
    feed,
    pinnedIds: new Set(),
    replyTo: { id: "reply_1", authorName: "Alice", text: "hello" },
    setReplyTo: vi.fn(),
    searchQuery: "query",
    searchResults: [],
    search: vi.fn(),
    scrollTargetId: "message_1",
    setScrollTargetId: vi.fn(),
    consumeScrollTarget: vi.fn(),
    contextTarget: { serverId: "server_1", channelId: "source_1", label: "source", seq: 3 },
    setContextTarget: vi.fn(),
    openContextSeq: vi.fn(),
    onSheetReply: vi.fn(),
    jumpToSeq: vi.fn(),
    messageActions: {} as MessageChannelControllerValue["messageActions"],
    threadActions: {} as MessageChannelControllerValue["threadActions"],
    acceptMessage: vi.fn(() => true),
    handleTyping: vi.fn(),
    typingUsers: ["Alice"],
    ...overrides,
  } as MessageChannelControllerValue
}

function props(overrides: Partial<TextChannelViewProps> = {}): TextChannelViewProps {
  return {
    channelId: "channel_1",
    serverId: "server_1",
    serverParam: "server_1",
    channelName: "general",
    viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
    anchorMessageId: "message_1",
    notificationLevel: "Use Server Default",
    onSetNotificationLevel: vi.fn(),
    composerMembers: [],
    onSearchComposerMembers: vi.fn(),
    channelRefCandidates: [],
    memberPanelProps: { members: [] } as never,
    manageMembersDialog: React.createElement("manage-dialog"),
    uiHandlers: {},
    onOpenThread: vi.fn(),
    onOpenProfile: vi.fn(),
    resolveUserName: (id) => id,
    autoFocus: true,
    rightPanel: "members",
    controller: controller(),
    onTogglePanel: vi.fn(),
    onClosePanel: vi.fn(),
    ...overrides,
  }
}

describe("TextChannelView", () => {
  it("maps controller state into header, list, composer, panel, and context intents", () => {
    const value = props()
    const shell = TextChannelView(value)
    expect(shell.type).toBe(ChannelShell)

    const header = shell.props.header as React.ReactElement<Record<string, any>>
    expect(header.type).toBe(ChannelHeader)
    expect(header.props).toMatchObject({ channel: "general", rightPanel: "members" })

    const list = findElement(shell.props.body, MessageList)!
    expect(list.props).toMatchObject({ channel: "general", scrollToMessageId: "message_1", viewerUserId: "viewer_1" })
    const composer = findElement(shell.props.body, Composer)!
    expect(composer.props).toMatchObject({ autoFocus: true, draftKey: "server_1/channel_1", replyingTo: "Alice" })
    composer.props.onCancelReply()
    expect(value.controller.setReplyTo).toHaveBeenCalledWith(null)

    const panel = shell.props.panels as React.ReactElement<Record<string, any>>
    expect(panel.type).toBe(CommunityPanelSheet)
    panel.props.onOpenChange(true)
    expect(value.onClosePanel).not.toHaveBeenCalled()
    panel.props.onOpenChange(false)
    expect(value.onClosePanel).toHaveBeenCalledOnce()

    const context = findElement(shell.props.dialogs, MessageContextSheet)!
    expect(context.props).toMatchObject({ open: true, channelId: "source_1", targetSeq: 3 })
    context.props.onOpenChange(true)
    expect(value.controller.setContextTarget).not.toHaveBeenCalled()
    context.props.onOpenChange(false)
    expect(value.controller.setContextTarget).toHaveBeenCalledWith(null)
  })

  it("omits the panel and falls back to the route channel in a closed context", () => {
    const value = props({
      rightPanel: null,
      controller: controller({ replyTo: null, contextTarget: null }),
    })
    const shell = TextChannelView(value)
    expect(shell.props.panels).toBeNull()
    const context = findElement(shell.props.dialogs, MessageContextSheet)!
    expect(context.props).toMatchObject({ open: false, channelId: "channel_1", targetSeq: null })
  })
})
