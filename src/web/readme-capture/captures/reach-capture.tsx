"use client"

import { ChannelHeader } from "@/components/community/channels/channel-header"
import { ComposerPreview } from "@/components/community/messages/composer-preview"
import { Message } from "@/components/community/messages/message"
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { LandingShellMotion } from "@/components/home/landing-shell-motion"
import type { RenderMsg } from "@/lib/community/models/message"
import type { Category, Server } from "@/lib/community/models/navigation"
import type { CommunityProfile, DM } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const ignore = () => {}

const REACH_PROFILES = new Map<string, CommunityProfile>([
  ["rc-gus", { id: "rc-gus", name: "Gus", discriminator: "1813", avatar: LANDING_HUMAN_AVATARS.gus, presence: "online" }],
  ["rc-alli", { id: "rc-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", presence: "online" }],
  ["rc-ruthann", { id: "rc-ruthann", name: "Ruthann", discriminator: "4410", avatar: LANDING_HUMAN_AVATARS.ruthann, presence: "online" }],
  ["rc-shelly", { id: "rc-shelly", name: "Shelly", discriminator: "3863", avatar: LANDING_HUMAN_AVATARS.shelly, presence: "online" }],
])

const REACH_SERVERS: Server[] = [
  { id: "rc-gus", name: "Gus", initial: "G", active: true, unread: false, mentions: 0, isOwner: true, icon: null },
  { id: "rc-studio", name: "Studio", initial: "S", active: false, unread: false, mentions: 0, isOwner: true, icon: null },
]

const REACH_CHANNELS: Category[] = [
  {
    id: "public",
    name: "Public",
    channels: [
      { id: "rc-general", name: "general", active: true, unread: false, type: "text" },
      { id: "rc-design", name: "design-review", active: false, unread: false, type: "text" },
    ],
  },
  {
    id: "private",
    name: "Private",
    channels: [
      { id: "rc-launch", name: "launch-room", active: false, unread: false, type: "text" },
    ],
  },
]

const REACH_DMS: DM[] = [
  { id: "rc-dm-alli", userId: "rc-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", avatarVersion: 0, status: "online", preview: "Preview ready" },
]

const REACH_MESSAGES: RenderMsg[] = [
  {
    id: "rc-m1",
    type: "chat",
    authorId: "rc-gus",
    authorName: "Gus",
    authorAvatar: LANDING_HUMAN_AVATARS.gus,
    content: "The headline is hard to read on my phone. Can you make it larger?",
    createdAt: "2026-08-06T04:20:00.000Z",
    seq: 1,
    grouped: false,
  },
  {
    id: "rc-m2",
    type: "chat",
    authorId: "rc-alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:Alli",
    content: "I’ve made it larger and checked the phone layout. Preview is ready.",
    createdAt: "2026-08-06T04:21:00.000Z",
    seq: 2,
    grouped: false,
    reactions: [
      { emoji: "👍", count: 2, me: true, userIds: ["rc-gus", "rc-ruthann"] },
    ],
  },
  {
    id: "rc-m3",
    type: "chat",
    authorId: "rc-ruthann",
    authorName: "Ruthann",
    authorAvatar: LANDING_HUMAN_AVATARS.ruthann,
    content: "The headline is clearer. Can you update the button text to match?",
    createdAt: "2026-08-06T04:22:00.000Z",
    seq: 3,
    grouped: false,
  },
  {
    id: "rc-m4",
    type: "chat",
    authorId: "rc-shelly",
    authorName: "Shelly",
    authorAvatar: LANDING_HUMAN_AVATARS.shelly,
    content: "Reviewed the updated page on mobile — ready to ship.",
    createdAt: "2026-08-06T04:23:00.000Z",
    seq: 4,
    grouped: false,
  },
]

export function ReachCapture() {
  return (
    <>
      <section id="capture-reach" className="feature-canvas reach-canvas capture-static">
        <CommunityPreviewNavigation value={true}>
          <div
            className="reach-laptop"
            data-slot="laptop-mockup-card"
            data-variant="starlight"
          >
            <div className="reach-laptop-lid">
              <div className="reach-laptop-bezel">
                <div className="reach-laptop-screen">
                  <LandingShellMotion
                    scene="server"
                    beat={6}
                    previewServers={REACH_SERVERS}
                    previewChannels={REACH_CHANNELS}
                    dms={REACH_DMS}
                    userAvatar={LANDING_HUMAN_AVATARS.gus}
                  >
                    <CommunityPreviewProfileOwner profiles={REACH_PROFILES}>
                      <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={ignore} />
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div className="flex-1 overflow-hidden py-3 pl-5 pr-28">
                          {REACH_MESSAGES.map((message) => (
                            <div key={message.id} className="py-1.5">
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
              </div>
            </div>
            <div className="reach-laptop-base" aria-hidden="true">
              <span className="reach-laptop-notch" />
            </div>
          </div>

          <div
            className="reach-phone-shell"
            data-slot="phone-mockup-card"
            data-variant="titanium"
          >
            <span className="reach-phone-btn reach-phone-mute" aria-hidden="true" />
            <span className="reach-phone-btn reach-phone-vol-up" aria-hidden="true" />
            <span className="reach-phone-btn reach-phone-vol-down" aria-hidden="true" />
            <span className="reach-phone-btn reach-phone-power" aria-hidden="true" />
            <div className="reach-phone-bezel">
              <div className="reach-phone-screen">
                <div className="reach-phone-content">
                  <div className="reach-phone-status" aria-hidden="true">
                    <span>9:41</span>
                    <span className="reach-phone-indicators">
                      <span className="reach-signal">
                        <i style={{ height: 4 }} />
                        <i style={{ height: 6 }} />
                        <i style={{ height: 8 }} />
                        <i style={{ height: 10 }} />
                      </span>
                      <span className="reach-battery">
                        <i />
                      </span>
                    </span>
                  </div>
                  <CommunityPreviewProfileOwner profiles={REACH_PROFILES}>
                    <div className="flex min-h-0 flex-1 flex-col bg-background">
                      <ChannelHeader
                        channel="general"
                        kind="text"
                        rightPanel={null}
                        onToggle={ignore}
                        mobileBack={ignore}
                        mobileBackDisplay="always"
                        tools={{ threads: false, pinned: false, members: false }}
                      />
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div className="flex-1 overflow-hidden px-3 py-2">
                          {REACH_MESSAGES.map((message) => (
                            <div key={message.id} className="py-1">
                              <Message m={message} onOpenThread={ignore} />
                            </div>
                          ))}
                        </div>
                        <ComposerPreview>
                          <div className="min-h-6 text-sm chat-input-line-height">
                            <span className="text-muted-foreground">Message /general</span>
                          </div>
                        </ComposerPreview>
                      </div>
                    </div>
                  </CommunityPreviewProfileOwner>
                </div>
                <span className="reach-phone-island" aria-hidden="true">
                  <span />
                </span>
                <span className="reach-phone-home" aria-hidden="true" />
              </div>
            </div>
          </div>
        </CommunityPreviewNavigation>
      </section>

      <style jsx global>{`
        .reach-laptop {
          position: absolute;
          z-index: 2;
          top: 32px;
          left: 28px;
          display: flex;
          width: 1020px;
          flex-direction: column;
          align-items: center;
        }

        .reach-laptop-lid {
          width: 90%;
          overflow: hidden;
          border: 2px solid #d8cdb8;
          border-bottom: 0;
          border-radius: 16px 16px 0 0;
          box-shadow:
            0 30px 64px rgb(31 26 21 / 22%),
            0 10px 24px rgb(31 26 21 / 12%);
        }

        .reach-laptop-bezel {
          padding: 9px 9px 0;
          background: #232226;
        }

        .reach-laptop-screen {
          height: 590px;
          overflow: hidden;
          border-radius: 6px 6px 0 0;
          background: var(--background);
        }

        .reach-laptop-screen header > span[aria-label] {
          display: none !important;
        }

        .reach-laptop-screen [data-testid="landing-motion-stage"] {
          width: 896px;
          height: 590px;
          aspect-ratio: auto;
        }

        .reach-laptop-screen [data-testid="landing-motion-stage"] > div {
          width: 840px !important;
          height: 553px !important;
          transform: scale(1.06667) !important;
          transform-origin: top left !important;
        }

        .reach-laptop-screen [data-testid="landing-motion-stage"] > div > div {
          width: 840px !important;
          height: 553px !important;
          transform-origin: 420px 276px !important;
        }

        .reach-laptop-base {
          position: relative;
          width: 100%;
          height: 18px;
          border-radius: 0 0 14px 14px;
          background: linear-gradient(to bottom, #f0e6d4, #d6c8ad);
          box-shadow:
            0 18px 34px rgb(31 26 21 / 20%),
            inset 0 1px 0 rgb(255 255 255 / 72%);
        }

        .reach-laptop-notch {
          position: absolute;
          top: 0;
          left: 50%;
          width: 92px;
          height: 5px;
          border-radius: 0 0 6px 6px;
          background: #c5b695;
          transform: translateX(-50%);
        }

        .reach-phone-shell {
          position: absolute;
          z-index: 5;
          right: 32px;
          bottom: 24px;
          width: 292px;
          height: 604px;
          padding: 3px;
          border-radius: 40px;
          background: linear-gradient(145deg, #c2bbb2, #8e887f 55%, #a7a096);
          box-shadow:
            0 32px 66px rgb(31 26 21 / 30%),
            0 12px 24px rgb(31 26 21 / 18%);
        }

        .reach-phone-bezel {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
          border-radius: 37px;
          background: #0c0c0e;
        }

        .reach-phone-screen {
          position: absolute;
          inset: 6px;
          overflow: hidden;
          border-radius: 31px;
          background: var(--background);
        }

        .reach-phone-content {
          display: flex;
          width: 356px;
          height: 752px;
          flex-direction: column;
          padding-bottom: 14px;
          transform: scale(0.76966);
          transform-origin: top left;
        }

        .reach-phone-status {
          display: flex;
          height: 44px;
          flex-shrink: 0;
          align-items: center;
          justify-content: space-between;
          padding: 8px 24px 0;
          color: var(--foreground);
          font-size: 14px;
          font-weight: 600;
        }

        .reach-phone-indicators {
          display: flex;
          align-items: center;
          gap: 7px;
        }

        .reach-signal {
          display: inline-flex;
          align-items: flex-end;
          gap: 2px;
        }

        .reach-signal i {
          display: block;
          width: 3px;
          border-radius: 1px;
          background: currentColor;
        }

        .reach-battery {
          position: relative;
          display: inline-flex;
          width: 22px;
          height: 11px;
          align-items: center;
          padding: 1.5px;
          border: 1.5px solid currentColor;
          border-radius: 3px;
        }

        .reach-battery::after {
          position: absolute;
          right: -3.5px;
          width: 2px;
          height: 5px;
          border-radius: 0 1px 1px 0;
          background: currentColor;
          content: "";
        }

        .reach-battery i {
          display: block;
          width: 82%;
          height: 100%;
          border-radius: 1px;
          background: currentColor;
        }

        .reach-phone-btn {
          position: absolute;
          z-index: 1;
          width: 3px;
          border-radius: 2px 0 0 2px;
          background: #8f8981;
        }

        .reach-phone-mute {
          top: 15%;
          left: -3px;
          height: 20px;
        }

        .reach-phone-vol-up {
          top: 21%;
          left: -3px;
          height: 42px;
        }

        .reach-phone-vol-down {
          top: 30%;
          left: -3px;
          height: 42px;
        }

        .reach-phone-power {
          top: 23%;
          right: -3px;
          height: 64px;
          border-radius: 0 2px 2px 0;
        }

        .reach-phone-island {
          position: absolute;
          z-index: 20;
          top: 9px;
          left: 50%;
          width: 74px;
          height: 20px;
          border-radius: 999px;
          background: #0a0a0c;
          transform: translateX(-50%);
        }

        .reach-phone-island > span {
          position: absolute;
          top: 50%;
          right: 7px;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: rgb(106 144 200 / 28%);
          transform: translateY(-50%);
        }

        .reach-phone-home {
          position: absolute;
          z-index: 20;
          bottom: 7px;
          left: 50%;
          width: 96px;
          height: 4px;
          border-radius: 999px;
          background: rgb(31 26 21 / 28%);
          transform: translateX(-50%);
        }
      `}</style>
    </>
  )
}
