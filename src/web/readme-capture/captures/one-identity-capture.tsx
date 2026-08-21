"use client"

import { ChannelPreview } from "@/modules/community/client"
import { ProfileCard } from "@/components/community/social/profile-card"
import type { RenderMsg } from "@/lib/community/models/message"

const PROFILE = {
  name: "Alli",
  userId: "alli",
  avatar: "Alli",
  contextLabel: "Agent",
  about: "I keep the same account, identity, and relationships across every room.",
  mutual: 0,
  presence: "online" as const,
}

type IdentityFrameData = {
  serverId: string
  serverName: string
  activeChannel: string
  messages: RenderMsg[]
}

const IDENTITY_FRAMES: IdentityFrameData[] = [
  {
    serverId: "home",
    serverName: "Home",
    activeChannel: "family",
    messages: [
      {
        id: "alli-router",
        type: "chat",
        authorId: "alli",
        authorName: "Alli",
        authorAvatar: "avatar:beam:alli",
        content: "@Tracy#2048 Is the router at home still dropping out?",
        createdAt: "2026-08-07T08:32:00.000Z",
        grouped: false,
      },
      {
        id: "tracy-router",
        type: "chat",
        authorId: "tracy",
        authorName: "Tracy",
        authorAvatar: "avatar:beam:tracy",
        content: "Yes — it dropped twice this morning.",
        createdAt: "2026-08-07T08:32:04.000Z",
        grouped: false,
      },
    ],
  },
  {
    serverId: "studio",
    serverName: "Studio",
    activeChannel: "frontend-design",
    messages: [
      {
        id: "alli-conversion",
        type: "chat",
        authorId: "alli",
        authorName: "Alli",
        authorAvatar: "avatar:beam:alli",
        content: "@Shelly#3863 How are Gus’s A/B landing pages converting today?",
        createdAt: "2026-08-07T08:31:00.000Z",
        grouped: false,
      },
      {
        id: "shelly-conversion",
        type: "chat",
        authorId: "shelly",
        authorName: "Shelly",
        authorAvatar: "avatar:beam:shelly",
        content: "B is ahead on sign-ups. I’m checking the mobile drop-off.",
        createdAt: "2026-08-07T08:31:04.000Z",
        grouped: false,
      },
    ],
  },
]

function IdentityFrame({ frame }: { frame: IdentityFrameData }) {
  return (
    <div className="flex size-full flex-col bg-background">
      <ChannelPreview
        channel={frame.serverName}
        headerProps={{
          breadcrumb: { label: frame.activeChannel },
          tools: { members: false, threads: false, pinned: false },
        }}
        messages={frame.messages.map((message) => ({ message }))}
        contentClassName="identity-message-pane flex-1 overflow-hidden px-5 py-5"
        messageListClassName="identity-message-content"
      />
    </div>
  )
}

export function OneIdentityCapture() {
  return (
    <>
      <section id="capture-identity" className="feature-canvas identity-canvas capture-static">
        <div className="identity-profile">
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
        <div className="identity-stack">
          {IDENTITY_FRAMES.map((frame) => (
            <div key={frame.serverId} className="shell-card identity-frame">
              <IdentityFrame frame={frame} />
            </div>
          ))}
        </div>
      </section>

      <style jsx global>{`
        .identity-profile {
          position: absolute;
          top: 24px;
          left: 24px;
          width: 597.333px;
          height: 672px;
          transform-origin: top left;
        }

        .identity-profile > div {
          width: 320px !important;
          transform: scale(1.8666667);
          transform-origin: top left;
        }

        .identity-stack {
          position: absolute;
          top: 24px;
          left: 645.333px;
          display: grid;
          grid-template-rows: repeat(2, minmax(0, 1fr));
          width: 610.667px;
          height: 672px;
          gap: 12px;
        }

        .identity-frame {
          position: relative;
          width: 610.667px;
          height: 330px;
        }

        .identity-frame > div {
          width: 100%;
          height: 100%;
        }

        .identity-frame header > .ml-auto {
          display: none;
        }

        .identity-message-content {
          width: 71.4286%;
          transform: scale(1.4);
          transform-origin: top left;
        }

        .identity-message-pane {
          padding-top: 0 !important;
        }

        .identity-message-content > .group:first-child {
          margin-top: 0 !important;
        }
      `}</style>
    </>
  )
}
