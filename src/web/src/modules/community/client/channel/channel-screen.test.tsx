import { describe, expect, it } from "vitest"
import React from "react"
import { ChannelScreen } from "./channel-screen"
import { ChannelController } from "./internal/channel-controller"
import { ChannelView } from "./internal/channel-view"
import { ChannelScreenSkeleton } from "./channel-screen-skeleton"
import { ChannelHeaderSkeleton } from "./channel-header"
import { ChannelShell } from "./channel-shell"
import { TextChannelController } from "./internal/text-channel-controller"
import { ForumChannelSurface } from "@/components/community/channels/forum-channel-surface"
import { ThreadChannelSurface } from "@/components/community/channels/thread-channel-surface"
import { ForumViewSkeleton } from "@/components/community/channels/forum-view"
import { ComposerSkeleton, MessageList } from "../messaging"

describe("ChannelScreen", () => {
  it("keeps the route boundary as a thin controller handoff", () => {
    const element = ChannelScreen({ serverParam: "server%201", channelId: "channel_1" })
    expect(element.type).toBe(ChannelController)
    expect(element.props).toEqual({ serverParam: "server%201", channelId: "channel_1" })
  })

  it("selects loading, child, forum, and text presentation branches", () => {
    const base = {
      channelId: "channel_1",
      hydrated: true,
      isForum: false,
      isChildChannel: false,
      thread: {} as never,
      forum: {} as never,
      text: {} as never,
    }
    expect(ChannelView({ ...base, hydrated: false }).type).toBe(ChannelScreenSkeleton)
    expect(ChannelView({ ...base, isChildChannel: true }).type).toBe(ThreadChannelSurface)
    expect(ChannelView({ ...base, isForum: true }).type).toBe(ForumChannelSurface)
    expect(ChannelView(base).type).toBe(TextChannelController)
  })

  it("keeps text and forum loading frames dimensionally aligned", () => {
    const onBack = () => {}
    const text = ChannelScreenSkeleton({ channelId: "channel_1", onBack })
    const [header, main] = React.Children.toArray(text.props.children) as React.ReactElement<Record<string, any>>[]
    expect(header.type).toBe(ChannelHeaderSkeleton)
    expect(header.props.onBack).toBe(onBack)
    const [list, composer] = React.Children.toArray(main.props.children) as React.ReactElement<Record<string, any>>[]
    expect(list.type).toBe(MessageList)
    expect(list.key).toContain("channel_1")
    list.props.onOpenThread()
    expect(composer.type).toBe(ComposerSkeleton)

    const forum = ChannelScreenSkeleton({ forum: true })
    const forumMain = React.Children.toArray(forum.props.children)[1] as React.ReactElement<Record<string, any>>
    const forumChildren = React.Children.toArray(forumMain.props.children) as React.ReactElement<Record<string, any>>[]
    expect(forumChildren).toHaveLength(1)
    expect(forumChildren[0].type).toBe(ForumViewSkeleton)
  })

  it("keeps ChannelShell as a slot-only fragment", () => {
    const shell = ChannelShell({ header: "header", body: "body", panels: "panels", dialogs: "dialogs" })
    expect(React.Children.toArray(shell.props.children)).toEqual(["header", "body", "panels", "dialogs"])
  })
})
