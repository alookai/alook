"use client"

import { Message } from "@/components/community/messages/message"
import { ServerIcon } from "@/components/community/server-icon"
import { ProfileCard } from "@/components/community/social/profile-card"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { LANDING_PREVIEW_PROFILES } from "@/components/home/landing-shell-motion"
import type { RenderMsg } from "@/lib/community/models/message"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const PROFILE = {
  name: "Alli",
  userId: "alli",
  avatar: "avatar:beam:Alli",
  contextLabel: "Agent",
  about: "I keep the same account, identity, and relationships across every room.",
  mutual: 0,
  presence: "online" as const,
}

const IDENTITY_PROFILES = new Map<string, CommunityProfile>([
  ...LANDING_PREVIEW_PROFILES,
  [PROFILE.userId, {
    ...LANDING_PREVIEW_PROFILES.get(PROFILE.userId),
    id: PROFILE.userId,
    name: PROFILE.name,
    discriminator: "6011",
    avatar: PROFILE.avatar,
    aboutMe: PROFILE.about,
    presence: PROFILE.presence,
    statusText: "Free for dinner",
  }],
  ["tracy", { id: "tracy", name: "Tracy", discriminator: "2048", avatar: LANDING_HUMAN_AVATARS.tracy, presence: "online" }],
  ["shelly", { id: "shelly", name: "Shelly", discriminator: "3863", avatar: LANDING_HUMAN_AVATARS.shelly, presence: "online" }],
])

type IdentityFrameData = {
  serverId: string
  serverName: string
  serverInitial: string
  activeChannel: string
  messages: RenderMsg[]
}

const IDENTITY_FRAMES: IdentityFrameData[] = [
  {
    serverId: "home",
    serverName: "Home",
    serverInitial: "H",
    activeChannel: "family",
    messages: [
      {
        id: "alli-router",
        type: "chat",
        authorId: "alli",
        authorName: "Alli",
        authorAvatar: "avatar:beam:Alli",
        content: "@Tracy#2048 Can we confirm the Saturday plan we discussed?",
        createdAt: "2026-08-07T08:32:00.000Z",
        grouped: false,
      },
      {
        id: "tracy-router",
        type: "chat",
        authorId: "tracy",
        authorName: "Tracy",
        authorAvatar: LANDING_HUMAN_AVATARS.tracy,
        content: "Saturday at six works. I’ve added the address to our plan.",
        createdAt: "2026-08-07T08:32:04.000Z",
        grouped: false,
        reactions: [
          { emoji: "🎉", count: 2, me: true, userIds: ["alli", "tracy"] },
        ],
      },
    ],
  },
  {
    serverId: "studio",
    serverName: "Studio",
    serverInitial: "S",
    activeChannel: "frontend-design",
    messages: [
      {
        id: "alli-conversion",
        type: "chat",
        authorId: "alli",
        authorName: "Alli",
        authorAvatar: "avatar:beam:Alli",
        content: "@Shelly#3863 Have you checked the updated page on your phone?",
        createdAt: "2026-08-07T08:31:00.000Z",
        grouped: false,
      },
      {
        id: "shelly-conversion",
        type: "chat",
        authorId: "shelly",
        authorName: "Shelly",
        authorAvatar: LANDING_HUMAN_AVATARS.shelly,
        content: "Yes. The headline is clearer — ready to merge.",
        createdAt: "2026-08-07T08:31:04.000Z",
        grouped: false,
        reactions: [
          { emoji: "👍", count: 2, me: true, userIds: ["alli", "shelly"] },
        ],
      },
    ],
  },
]

function IdentityFrame({ frame }: { frame: IdentityFrameData }) {
  return (
    <div className="flex size-full flex-col bg-background">
      <div className="tn-room-bar">
        <ServerIcon
          id={frame.serverId}
          name={frame.serverName}
          initial={frame.serverInitial}
          icon={null}
          size={22}
          className="rounded-md"
        />
        <span className="tn-room-server">{frame.serverName}</span>
        <span className="tn-room-sep">/</span>
        <span className="tn-room-channel">{frame.activeChannel}</span>
      </div>
      <div className="identity-message-pane flex-1 overflow-hidden px-5 py-3">
        <div className="identity-message-content">
          {frame.messages.map((entry) => (
            <div key={entry.id} className="py-1">
              <Message m={entry} onOpenThread={() => undefined} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function OneIdentityCapture() {
  return (
    <>
      <CommunityPreviewProfileOwner profiles={IDENTITY_PROFILES}>
        <section id="capture-identity" className="feature-canvas identity-canvas capture-static">
          <svg
            className="identity-connectors"
            viewBox="0 0 1280 720"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M490 304 C540 304, 536 186, 586 186"
              stroke="#5f8bcf"
              strokeWidth="2.5"
              strokeDasharray="6 6"
              strokeLinecap="round"
              opacity="0.72"
            />
            <path
              d="M490 404 C538 404, 526 530, 566 530"
              stroke="#5f8bcf"
              strokeWidth="2.5"
              strokeDasharray="6 6"
              strokeLinecap="round"
              opacity="0.72"
            />
            <circle cx="490" cy="304" r="5" fill="#5f8bcf" />
            <circle cx="586" cy="186" r="5" fill="#5f8bcf" />
            <circle cx="490" cy="404" r="5" fill="#5f8bcf" />
            <circle cx="566" cy="530" r="5" fill="#5f8bcf" />
          </svg>

          <div className="tn-sticker identity-profile">
            <ProfileCard
              embedded
              data={PROFILE}
              x={0}
              y={0}
              bp="desktop"
              onClose={() => undefined}
              initialStatusText="Free for dinner"
            />
          </div>

          <div className="tn-window identity-frame identity-frame-top">
            <IdentityFrame frame={IDENTITY_FRAMES[0]} />
          </div>

          <div className="tn-window identity-frame identity-frame-bottom">
            <IdentityFrame frame={IDENTITY_FRAMES[1]} />
          </div>
        </section>
      </CommunityPreviewProfileOwner>

      <style jsx global>{`
        .identity-connectors {
          position: absolute;
          inset: 0;
          z-index: 1;
          pointer-events: none;
        }

        .identity-profile {
          position: absolute;
          z-index: 3;
          top: 136px;
          left: 44px;
          width: 448px;
          height: 432px;
          padding: 0;
          overflow: hidden;
          transform: rotate(-1.8deg);
        }

        .identity-profile > div {
          width: 320px !important;
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          transform: scale(1.4);
          transform-origin: top left;
        }

        .identity-profile > div [data-testid="profile-card"],
        .identity-profile > div > div {
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
        }

        .identity-frame {
          position: absolute;
          z-index: 2;
          width: 660px;
          height: 296px;
        }

        .identity-frame-top {
          top: 40px;
          right: 38px;
          transform: rotate(1.1deg);
        }

        .identity-frame-bottom {
          right: 60px;
          bottom: 40px;
          transform: rotate(-0.8deg);
        }

        .identity-message-content {
          width: 83.3333%;
          transform: scale(1.2);
          transform-origin: top left;
        }
      `}</style>
    </>
  )
}
