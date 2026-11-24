"use client"

import { BotCardView } from "@/components/community/bots/bot-card-view"
import { ChannelHeader } from "@/components/community/channels/channel-header"
import { MemberIdentityRow } from "@/components/community/members/member-identity-row"
import { ComposerPreview } from "@/components/community/messages/composer-preview"
import { Message } from "@/components/community/messages/message"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import type { BotTokenUsage } from "@/hooks/community/use-bots"
import type { RenderMsg } from "@/lib/community/models/message"
import type { Category, Server } from "@/lib/community/models/navigation"
import type { CommunityProfile, DM } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const ignore = () => {}

const OVERVIEW_PROFILES = new Map<string, CommunityProfile>([
  ["ov-gus", { id: "ov-gus", name: "Gus", discriminator: "1813", avatar: LANDING_HUMAN_AVATARS.gus, presence: "online" }],
  ["ov-alli", { id: "ov-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", presence: "online" }],
  ["ov-shelly", { id: "ov-shelly", name: "Shelly", discriminator: "3863", avatar: LANDING_HUMAN_AVATARS.shelly, presence: "online" }],
  ["ov-ruthann", { id: "ov-ruthann", name: "Ruthann", discriminator: "4410", avatar: LANDING_HUMAN_AVATARS.ruthann, presence: "online" }],
  ["ov-cecilia", { id: "ov-cecilia", name: "Cecilia", discriminator: "7971", avatar: "avatar:beam:Cecilia", presence: "online" }],
  ["ov-claudette", { id: "ov-claudette", name: "Claudette", discriminator: "5211", avatar: "avatar:beam:Claudette", presence: "online" }],
])

const OVERVIEW_SERVERS: Server[] = [
  { id: "ov-studio", name: "Studio", initial: "S", active: true, unread: false, mentions: 0, isOwner: true, icon: null },
  { id: "ov-home", name: "Home", initial: "H", active: false, unread: false, mentions: 0, isOwner: false, icon: null },
  { id: "ov-alook", name: "Alook", initial: "A", active: false, unread: true, mentions: 2, isOwner: true, icon: null },
]

const OVERVIEW_CHANNELS: Category[] = [
  {
    id: "public",
    name: "Public",
    channels: [
      { id: "ch-general", name: "general", active: true, unread: false, type: "text" },
      { id: "ch-design", name: "design-review", active: false, unread: true, type: "text" },
      { id: "ch-roadmap", name: "roadmap", active: false, unread: false, type: "text" },
    ],
  },
  {
    id: "private",
    name: "Private",
    channels: [
      { id: "ch-launch", name: "launch-room", active: false, unread: false, type: "text" },
      { id: "ch-releases", name: "release-notes", active: false, unread: false, type: "text" },
    ],
  },
]

const OVERVIEW_DMS: DM[] = [
  { id: "dm-alli", userId: "ov-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", avatarVersion: 0, status: "online", preview: "Updated the mobile layout" },
]

const OVERVIEW_MESSAGES: RenderMsg[] = [
  {
    id: "ov-m1",
    type: "chat",
    authorId: "ov-gus",
    authorName: "Gus",
    authorAvatar: LANDING_HUMAN_AVATARS.gus,
    content: "Shelly, Ruthann — Alli is in this room too. Feel free to review the new layout directly with her.",
    createdAt: "2026-10-21T01:00:00.000Z",
    seq: 1,
    grouped: false,
  },
  {
    id: "ov-m2",
    type: "chat",
    authorId: "ov-shelly",
    authorName: "Shelly",
    authorAvatar: LANDING_HUMAN_AVATARS.shelly,
    content: "@Alli#6011 The mobile header feels much cleaner. Can we tighten the card spacing below it?",
    createdAt: "2026-10-21T01:01:00.000Z",
    seq: 2,
    grouped: false,
    reactions: [
      { emoji: "👍", count: 2, me: true, userIds: ["ov-gus", "ov-ruthann"] },
      { emoji: "🎨", count: 1, me: false, userIds: ["ov-alli"] },
    ],
  },
  {
    id: "ov-m3",
    type: "chat",
    authorId: "ov-alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:Alli",
    content: "Done — tightened the card rhythm and checked both light and dark views. Preview is ready for a pass.",
    createdAt: "2026-10-21T01:02:00.000Z",
    seq: 3,
    grouped: false,
  },
  {
    id: "ov-m4",
    type: "chat",
    authorId: "ov-ruthann",
    authorName: "Ruthann",
    authorAvatar: LANDING_HUMAN_AVATARS.ruthann,
    content: "Checked on my phone — reads great. Ready to ship.",
    createdAt: "2026-10-21T01:03:00.000Z",
    seq: 4,
    grouped: false,
  },
]

const ONLINE_MEMBERS = [
  { id: "ov-alli", name: "Alli", avatar: "avatar:beam:Alli", secondary: "Working on it" },
  { id: "ov-cecilia", name: "Cecilia", avatar: "avatar:beam:Cecilia" },
  { id: "ov-claudette", name: "Claudette", avatar: "avatar:beam:Claudette" },
  { id: "ov-ruthann", name: "Ruthann", avatar: LANDING_HUMAN_AVATARS.ruthann },
  { id: "ov-shelly", name: "Shelly", avatar: LANDING_HUMAN_AVATARS.shelly },
]

const ALLI_USAGE: BotTokenUsage = {
  capability: "supported",
  days: Array.from({ length: 14 }, (_, i) => ({
    day: `2026-10-${String(i + 8).padStart(2, "0")}`,
    period: i === 13 ? "in_progress" : "closed",
    metrics: {
      input: 65_000 + ((i * 29_173) % 180_000),
      output: 12_000 + ((i * 5_307) % 32_000),
      cache: 180_000 + ((i * 41_101) % 420_000),
    },
  })),
}

export function OverviewCapture() {
  return (
    <>
      <section
        id="capture-overview"
        className="feature-canvas overview-canvas capture-static"
        style={{ width: 1182, height: 797 }}
      >
        <CommunityPreviewNavigation value={true}>
          <div className="tn-window overview-window">
            <LandingShellMotion
              scene="server"
              beat={6}
              previewServers={OVERVIEW_SERVERS}
              previewChannels={OVERVIEW_CHANNELS}
              dms={OVERVIEW_DMS}
              userAvatar={LANDING_HUMAN_AVATARS.gus}
            >
              <CommunityPreviewProfileOwner profiles={OVERVIEW_PROFILES}>
                <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={ignore} />
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="flex-1 overflow-hidden py-3 pl-5 pr-20">
                    <div className="mb-3 flex items-center gap-3">
                      <span className="h-px flex-1 bg-border/70" />
                      <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                        Oct 21, 2026
                      </span>
                      <span className="h-px flex-1 bg-border/70" />
                    </div>
                    {OVERVIEW_MESSAGES.slice(0, 2).map((message) => (
                      <div key={message.id} className="py-1">
                        <Message m={message} onOpenThread={ignore} />
                      </div>
                    ))}
                    <div className="my-2 flex items-center gap-2">
                      <span className="h-px flex-1 bg-destructive/75" />
                      <span className="rounded-full bg-destructive px-2 py-0.5 text-[10px] font-semibold text-white">
                        New
                      </span>
                    </div>
                    {OVERVIEW_MESSAGES.slice(2).map((message) => (
                      <div key={message.id} className="py-1">
                        <Message m={message} onOpenThread={ignore} />
                      </div>
                    ))}
                  </div>
                  <ComposerPreview>
                    <div className="min-h-6 text-base chat-input-line-height">
                      <span className="text-muted-foreground">Message /general</span>
                    </div>
                  </ComposerPreview>
                </div>
              </CommunityPreviewProfileOwner>
            </LandingShellMotion>
          </div>

          <CommunityPreviewProfileOwner profiles={OVERVIEW_PROFILES}>
            <aside className="tn-sticker overview-members">
              <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">Owner — 1</h3>
              <div className="px-1 py-1.5">
                <MemberIdentityRow
                  name="Gus"
                  avatarLabel={LANDING_HUMAN_AVATARS.gus}
                  avatarSeed="ov-gus"
                  presence="online"
                />
              </div>
              <h3 className="mt-3 mb-2 px-1 text-xs font-medium text-muted-foreground">Online — 5</h3>
              <div className="flex flex-col gap-1">
                {ONLINE_MEMBERS.map((member) => (
                  <div key={member.id} className="px-1 py-1">
                    <MemberIdentityRow
                      name={member.name}
                      avatarLabel={member.avatar}
                      avatarSeed={member.id}
                      presence="online"
                      secondary={member.secondary}
                    />
                  </div>
                ))}
              </div>
            </aside>

            <div className="tn-sticker overview-bot-card">
              <BotCardView
                bot={{
                  id: "ov-alli",
                  name: "Alli",
                  image: "avatar:beam:Alli",
                  runtime: "claude",
                  modelName: "claude-opus-5-5",
                  lastRefreshContextAt: null,
                  usage: ALLI_USAGE,
                }}
                online={true}
                statusKnown={true}
                statusLabel="Online"
              />
            </div>
          </CommunityPreviewProfileOwner>
        </CommunityPreviewNavigation>
      </section>

      <style jsx global>{`
        .overview-canvas {
          width: 1182px;
          height: 797px;
        }

        .overview-window {
          position: absolute;
          top: 34px;
          left: 32px;
          width: 964px;
          height: 718px;
        }

        .overview-window header > span[aria-label] {
          display: none !important;
        }

        .overview-window [data-testid="landing-motion-stage"] {
          width: 964px;
          height: 718px;
          aspect-ratio: auto;
        }

        .overview-window [data-testid="landing-motion-stage"] > div {
          width: 900px !important;
          height: 670px !important;
          transform: scale(1.0711) !important;
          transform-origin: top left !important;
        }

        .overview-window [data-testid="landing-motion-stage"] > div > div {
          width: 900px !important;
          height: 670px !important;
          transform-origin: 450px 335px !important;
        }

        .overview-members {
          position: absolute;
          z-index: 3;
          top: 26px;
          right: 24px;
          width: 226px;
          padding: 15px 13px 13px;
          transform: rotate(1.5deg);
        }

        .overview-bot-card {
          position: absolute;
          z-index: 4;
          right: 28px;
          bottom: 22px;
          width: 440px;
          padding: 0;
          overflow: hidden;
          transform: rotate(-1.3deg);
        }

        .overview-bot-card > [data-shell="cassette"] {
          border: 0 !important;
          border-radius: 13px !important;
          box-shadow: none !important;
        }
      `}</style>
    </>
  )
}
