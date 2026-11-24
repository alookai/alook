"use client"

import { DmHeader } from "@/components/community/channels/dm-header"
import { Message } from "@/components/community/messages/message"
import { ServerIcon } from "@/components/community/server-icon"
import { BotMarkStickerView } from "@/components/community/social/bot-mark-sticker"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import type { AuditEvent } from "@/lib/community/models/audit"
import type { Marked } from "@/lib/community/models/inbox"
import type { RenderMsg } from "@/lib/community/models/message"
import type { CommunityProfile, DM } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const ignore = () => {}

const MEMORY_PROFILES = new Map<string, CommunityProfile>([
  ["mem-gus", { id: "mem-gus", name: "Gus", discriminator: "1813", avatar: LANDING_HUMAN_AVATARS.gus, presence: "online" }],
  ["mem-alli", { id: "mem-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", presence: "online" }],
  ["mem-shelly", { id: "mem-shelly", name: "Shelly", discriminator: "3863", avatar: LANDING_HUMAN_AVATARS.shelly, presence: "online" }],
  ["mem-tracy", { id: "mem-tracy", name: "Tracy", discriminator: "2048", avatar: LANDING_HUMAN_AVATARS.tracy, presence: "online" }],
])

const ALLI_DM: DM = {
  id: "mem-dm-alli",
  userId: "mem-alli",
  name: "Alli",
  discriminator: "6011",
  avatar: "avatar:beam:Alli",
  avatarVersion: 0,
  status: "online",
  preview: "",
}

const DM_MESSAGES: RenderMsg[] = [
  {
    id: "mem-dm-1",
    type: "chat",
    authorId: "mem-gus",
    authorName: "Gus",
    authorAvatar: LANDING_HUMAN_AVATARS.gus,
    content: "Alli, follow up on the homepage review and our weekend plan.",
    createdAt: "2026-10-21T08:30:00.000Z",
    grouped: false,
  },
  {
    id: "mem-dm-2",
    type: "chat",
    authorId: "mem-alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:Alli",
    content: "Got it. I’ll check the mobile layout with Shelly in Studio, then confirm Saturday with Tracy.",
    createdAt: "2026-10-21T08:30:20.000Z",
    grouped: false,
  },
]

const STUDIO_MESSAGES: RenderMsg[] = [
  {
    id: "mem-st-1",
    type: "chat",
    authorId: "mem-alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:Alli",
    content: "@Shelly#3863 Mobile headline is updated on preview — does the spacing feel right?",
    createdAt: "2026-10-21T08:32:00.000Z",
    grouped: false,
  },
  {
    id: "mem-st-2",
    type: "chat",
    authorId: "mem-shelly",
    authorName: "Shelly",
    authorAvatar: LANDING_HUMAN_AVATARS.shelly,
    content: "Much sharper on phone now. Good to ship.",
    createdAt: "2026-10-21T08:32:18.000Z",
    grouped: false,
    reactions: [
      { emoji: "👍", count: 2, me: true, userIds: ["mem-gus", "mem-alli"] },
    ],
  },
]

const BOT_THOUGHTS: AuditEvent[] = [
  {
    id: "mem-th-1",
    kind: "text",
    payload: { text: "Marked Gus’s DM request across two rooms: Studio review + Home Saturday plan.", truncated: false, chars: 76 },
    sessionId: null,
    launchId: null,
    createdAt: "2026-10-21T08:30:25.000Z",
  },
  {
    id: "mem-th-2",
    kind: "text",
    payload: { text: "Checked mobile headline rhythm and pinged Shelly in /Studio/frontend-design.", truncated: false, chars: 76 },
    sessionId: null,
    launchId: null,
    createdAt: "2026-10-21T08:32:05.000Z",
  },
  {
    id: "mem-th-3",
    kind: "text",
    payload: { text: "Shelly signed off on mobile. Next: confirm Saturday dinner with Tracy in /Home/family.", truncated: false, chars: 86 },
    sessionId: null,
    launchId: null,
    createdAt: "2026-10-21T08:33:00.000Z",
  },
]

const BOT_MARKS: Marked[] = [
  { id: "mem-mk-1", server: "Studio", serverId: "studio", channel: "frontend-design", channelId: "ch-fe", m: STUDIO_MESSAGES[0] },
  { id: "mem-mk-2", server: "", serverId: null, channel: "Gus", channelId: "dm-gus", m: DM_MESSAGES[0] },
  { id: "mem-mk-3", server: "Home", serverId: "home", channel: "family", channelId: "ch-fam", m: DM_MESSAGES[1] },
  { id: "mem-mk-4", server: "Studio", serverId: "studio", channel: "launch", channelId: "ch-launch", m: STUDIO_MESSAGES[1] },
]

export function MemoryCapture() {
  return (
    <>
      <CommunityPreviewProfileOwner profiles={MEMORY_PROFILES}>
        <section id="capture-memory" className="feature-canvas memory-canvas capture-static">
          <svg
            className="memory-connectors"
            viewBox="0 0 1280 720"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M786 196 C824 196, 818 258, 848 258"
              stroke="#5f8bcf"
              strokeWidth="2.5"
              strokeDasharray="6 6"
              strokeLinecap="round"
              opacity="0.72"
            />
            <path
              d="M848 472 C816 472, 826 522, 798 522"
              stroke="#5f8bcf"
              strokeWidth="2.5"
              strokeDasharray="6 6"
              strokeLinecap="round"
              opacity="0.72"
            />
            <circle cx="786" cy="196" r="5" fill="#5f8bcf" />
            <circle cx="848" cy="258" r="5" fill="#5f8bcf" />
            <circle cx="848" cy="472" r="5" fill="#5f8bcf" />
            <circle cx="798" cy="522" r="5" fill="#5f8bcf" />
          </svg>

          <div className="tn-window memory-card memory-card-top">
            <div className="flex size-full flex-col bg-background">
              <DmHeader dm={ALLI_DM} titleAs="div" />
              <div className="flex-1 overflow-hidden px-5 py-3">
                <div className="memory-msg-scale">
                  {DM_MESSAGES.map((message) => (
                    <div key={message.id} className="py-1">
                      <Message m={message} onOpenThread={ignore} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="tn-window memory-card memory-card-bottom">
            <div className="flex size-full flex-col bg-background">
              <div className="tn-room-bar">
                <ServerIcon id="studio" name="Studio" initial="S" icon={null} size={22} className="rounded-md" />
                <span className="tn-room-server">Studio</span>
                <span className="tn-room-sep">/</span>
                <span className="tn-room-channel">frontend-design</span>
              </div>
              <div className="flex-1 overflow-hidden px-5 py-3">
                <div className="memory-msg-scale">
                  {STUDIO_MESSAGES.map((message) => (
                    <div key={message.id} className="py-1">
                      <Message m={message} onOpenThread={ignore} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="memory-notebook">
            <div className="memory-notebook-inner">
              <BotMarkStickerView
                active={true}
                showStop={true}
                stopPending={false}
                onStop={ignore}
                activity={{ events: BOT_THOUGHTS, isLoading: false, isError: false, isNotFound: false }}
                marks={BOT_MARKS}
                isLoading={false}
                isError={false}
              />
            </div>
          </div>
        </section>
      </CommunityPreviewProfileOwner>

      <style jsx global>{`
        .memory-connectors {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
        }

        .memory-card {
          position: absolute;
          z-index: 2;
          width: 752px;
          height: 288px;
        }

        .memory-card-top {
          top: 42px;
          left: 34px;
          transform: rotate(-0.8deg);
        }

        .memory-card-bottom {
          bottom: 42px;
          left: 48px;
          transform: rotate(0.6deg);
        }

        .memory-msg-scale {
          width: 85.47%;
          transform: scale(1.17);
          transform-origin: top left;
        }

        .memory-notebook {
          position: absolute;
          z-index: 4;
          top: 72px;
          right: 34px;
          width: 416px;
          height: 576px;
          transform: rotate(1.7deg);
        }

        .memory-notebook-inner {
          width: 346px;
          height: 478px;
          transform: scale(1.202);
          transform-origin: top left;
        }
      `}</style>
    </>
  )
}
