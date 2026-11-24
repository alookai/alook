"use client"

import type { CommunityMachineSummary } from "@alook/shared"
import { BotCardView } from "@/components/community/bots/bot-card-view"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { MachineCard } from "@/components/community/machines/machine-card"
import { ComposerPreview } from "@/components/community/messages/composer-preview"
import { Message } from "@/components/community/messages/message"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import type { AgentRuntimePage } from "@/lib/agents"
import type { RenderMsg } from "@/lib/community/models/message"
import type { Category, Server } from "@/lib/community/models/navigation"
import type { CommunityProfile, DM } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const ignore = () => {}

const HUB_DMS: DM[] = [
  { id: "agents-dm-nova", userId: "agents-nova", name: "Nova", discriminator: "4102", avatar: "avatar:beam:nova", avatarVersion: 0, status: "online", preview: "Claude Code · Online" },
  { id: "agents-dm-milo", userId: "agents-milo", name: "Milo", discriminator: "4103", avatar: "avatar:beam:milo", avatarVersion: 0, status: "online", preview: "Codex · Online" },
  { id: "agents-dm-austina", userId: "agents-austina", name: "Austina", discriminator: "3717", avatar: "avatar:beam:austina", avatarVersion: 0, status: "online", preview: "Antigravity · Online" },
]

const HUB_MACHINE: CommunityMachineSummary = {
  id: "agents-hub-mac",
  hostname: "gus-macbook-pro.local",
  displayName: "Gus’s MacBook Pro",
  platform: "darwin",
  arch: "arm64",
  osRelease: "15.6",
  daemonVersion: "0.1.71",
  status: "online",
  lastSeenAt: "2026-11-24T01:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-24T01:00:00.000Z",
  availableRuntimes: [
    { id: "claude", status: "healthy" },
    { id: "codex-cli", status: "healthy" },
    { id: "cursor", status: "healthy" },
    { id: "antigravity", status: "healthy" },
    { id: "grok", status: "healthy" },
    { id: "opencode", status: "healthy" },
    { id: "pi", status: "healthy" },
    { id: "copilot", status: "healthy" },
    { id: "qoder", status: "healthy" },
  ],
} as CommunityMachineSummary

const HUB_BOTS = [
  {
    id: "agents-nova",
    name: "Nova",
    image: "avatar:beam:nova",
    runtime: "claude",
    modelName: "claude-sonnet-4-6",
    lastRefreshContextAt: null,
  },
  {
    id: "agents-milo",
    name: "Milo",
    image: "avatar:beam:milo",
    runtime: "codex-cli",
    modelName: "gpt-5.4",
    lastRefreshContextAt: null,
  },
  {
    id: "agents-austina",
    name: "Austina",
    image: "avatar:beam:austina",
    runtime: "antigravity",
    modelName: null,
    lastRefreshContextAt: null,
  },
  {
    id: "agents-kai",
    name: "Kai",
    image: "avatar:beam:kai",
    runtime: "cursor",
    modelName: null,
    lastRefreshContextAt: null,
  },
] as const

export function AgentsHubPreview() {
  return (
    <CommunityPreviewNavigation value={true}>
      <LandingShellMotion scene="machine" beat={0} dms={HUB_DMS}>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden p-6">
          <div className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
              <div>
                <div className="font-heading text-lg font-medium leading-[1.15] tracking-[-0.015em] text-foreground">
                  Machines
                </div>
                <p className="text-xs text-muted-foreground">
                  Your computers running the alook daemon.
                </p>
              </div>
            </header>
            <MachineCard machine={HUB_MACHINE} onDelete={ignore} onReconnect={ignore} />
          </div>

          <div className="flex flex-col gap-3">
            <div className="font-heading text-lg font-medium leading-[1.15] tracking-[-0.015em] text-foreground">
              My Bots
            </div>
            <div className="grid grid-cols-2 gap-3">
              {HUB_BOTS.map((bot) => (
                <BotCardView
                  key={bot.id}
                  bot={bot}
                  online={true}
                  statusKnown={true}
                  statusLabel="Online"
                />
              ))}
            </div>
          </div>
        </div>
      </LandingShellMotion>
    </CommunityPreviewNavigation>
  )
}

function slugId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

export function AgentChannelPreview({ agent }: { agent: AgentRuntimePage }) {
  const channelName = agent.channelPreview.channelName.replace(/^#/, "")
  const previewServers: Server[] = [
    { id: "alook-team", name: "Studio", initial: "S", active: true, unread: false, mentions: 0, isOwner: true, icon: null },
  ]
  const previewChannels: Category[] = [
    {
      id: "public",
      name: "Public",
      channels: [
        { id: `ch-${channelName}`, name: channelName, active: true, unread: false, type: "text" },
        { id: "ch-general", name: "general", active: false, unread: false, type: "text" },
      ],
    },
  ]

  const roster: CommunityProfile[] = []
  const seen = new Set<string>()
  for (const [index, msg] of agent.channelPreview.messages.entries()) {
    const id = `agent-preview-${slugId(msg.author)}`
    if (seen.has(id)) continue
    seen.add(id)
    roster.push({
      id,
      name: msg.author,
      discriminator: `41${String(index + 1).padStart(2, "0")}`,
      avatar: msg.isHuman ? LANDING_HUMAN_AVATARS.gus : `avatar:beam:${slugId(msg.seed ?? msg.author)}`,
    })
  }
  const directory = new Map<string, CommunityProfile>(roster.map((profile) => [profile.id, profile]))

  const start = Date.parse("2026-11-24T01:00:00.000Z")
  const renderedMessages: RenderMsg[] = agent.channelPreview.messages.map((msg, index) => {
    const authorId = `agent-preview-${slugId(msg.author)}`
    const profile = directory.get(authorId)!
    let content = msg.text
    for (const candidate of roster) {
      content = content.replaceAll(`@${candidate.name}`, `@${candidate.name}#${candidate.discriminator}`)
    }
    return {
      id: `agent-msg-${index}`,
      type: "chat",
      authorId: profile.id,
      authorName: profile.name,
      authorAvatar: profile.avatar ?? undefined,
      content,
      createdAt: new Date(start + index * 60_000).toISOString(),
      seq: index + 1,
      grouped: false,
    }
  })

  return (
    <CommunityPreviewNavigation value={true}>
      <LandingShellMotion
        scene="server"
        beat={0}
        previewServers={previewServers}
        previewChannels={previewChannels}
        dms={HUB_DMS}
      >
        <CommunityPreviewProfileOwner profiles={directory}>
          <ChannelHeader channel={channelName} kind="text" rightPanel={null} onToggle={ignore} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden px-4 py-3">
              {renderedMessages.map((message) => (
                <div key={message.id} className="py-1.5">
                  <Message m={message} onOpenThread={ignore} />
                </div>
              ))}
            </div>
            <ComposerPreview>
              <div className="min-h-6 text-base chat-input-line-height">
                <span className="text-muted-foreground">Message /{channelName}</span>
              </div>
            </ComposerPreview>
          </div>
        </CommunityPreviewProfileOwner>
      </LandingShellMotion>
    </CommunityPreviewNavigation>
  )
}
