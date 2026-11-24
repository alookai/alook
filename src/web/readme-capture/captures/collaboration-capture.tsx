"use client"

import type { FriendApprovalPayload } from "@alook/shared"
import { Avatar } from "@/components/community/avatar"
import { Message } from "@/components/community/messages/message"
import { ServerIcon } from "@/components/community/server-icon"
import { BotApprovalCard } from "@/components/community/social/bot-approval-card"
import { LANDING_HUMAN_AVATARS } from "@/components/home/landing-human-avatars"
import { Button } from "@/components/ui/button"
import type { RenderMsg } from "@/lib/community/models/message"
import type { CommunityProfile } from "@/lib/community/models/people"
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview"

const ignore = () => {}

const COLLAB_PROFILES = new Map<string, CommunityProfile>([
  ["co-gus", { id: "co-gus", name: "Gus", discriminator: "1813", avatar: LANDING_HUMAN_AVATARS.gus, presence: "online" }],
  ["co-alli", { id: "co-alli", name: "Alli", discriminator: "6011", avatar: "avatar:beam:Alli", presence: "online" }],
  ["co-shelly", { id: "co-shelly", name: "Shelly", discriminator: "2048", avatar: LANDING_HUMAN_AVATARS.shelly, presence: "online" }],
  ["co-tracy", { id: "co-tracy", name: "Tracy", discriminator: "4091", avatar: LANDING_HUMAN_AVATARS.tracy, presence: "online" }],
])

const COLLAB_MESSAGES: RenderMsg[] = [
  {
    id: "co-m1",
    type: "chat",
    authorId: "co-gus",
    authorName: "Gus",
    authorAvatar: LANDING_HUMAN_AVATARS.gus,
    content: "Shelly, Tracy — Alli is in this room too. You can work with her directly.",
    createdAt: "2026-10-21T01:00:00.000Z",
    seq: 1,
    grouped: false,
  },
  {
    id: "co-m2",
    type: "chat",
    authorId: "co-shelly",
    authorName: "Shelly",
    authorAvatar: LANDING_HUMAN_AVATARS.shelly,
    content: "@Alli#6011 Can we show how a shared room works right on the landing page?",
    createdAt: "2026-10-21T01:01:00.000Z",
    seq: 2,
    grouped: false,
    reactions: [
      { emoji: "👍", count: 2, me: true, userIds: ["co-gus", "co-tracy"] },
      { emoji: "🎨", count: 1, me: false, userIds: ["co-alli"] },
    ],
  },
  {
    id: "co-m3",
    type: "chat",
    authorId: "co-alli",
    authorName: "Alli",
    authorAvatar: "avatar:beam:Alli",
    content: "On it — I’ll put a live preview room below the hero so visitors can try it directly.",
    createdAt: "2026-10-21T01:02:00.000Z",
    seq: 3,
    grouped: false,
  },
  {
    id: "co-m4",
    type: "chat",
    authorId: "co-tracy",
    authorName: "Tracy",
    authorAvatar: LANDING_HUMAN_AVATARS.tracy,
    content: "Love that. Can I open her profile and DM her from there too?",
    createdAt: "2026-10-21T01:03:00.000Z",
    seq: 4,
    grouped: false,
  },
]

const FRIEND_APPROVAL: FriendApprovalPayload = {
  friendshipId: "co-fa-1",
  status: "pending",
  waitingOn: "you",
  otherProfile: {
    id: "co-shelly",
    name: "Shelly",
    discriminator: "2048",
    avatarVersion: 0,
    image: LANDING_HUMAN_AVATARS.shelly,
  },
  botProfile: {
    id: "co-alli",
    name: "Alli",
    discriminator: "6011",
    avatarVersion: 0,
    image: "avatar:beam:Alli",
  },
  waitingOnProfile: null,
}

export function CollaborationCapture() {
  return (
    <>
      <section id="capture-collaboration" className="feature-canvas collaboration-canvas">
        <CommunityPreviewProfileOwner profiles={COLLAB_PROFILES}>
          <div className="tn-window collab-room">
            <div className="flex size-full flex-col bg-background">
              <div className="tn-room-bar">
                <ServerIcon id="home" name="Home" initial="H" icon={null} size={22} className="rounded-md" />
                <span className="tn-room-server">Home</span>
                <span className="tn-room-sep">/</span>
                <span className="tn-room-channel">homepage-review</span>
              </div>
              <div className="flex-1 overflow-hidden px-5 pt-3 pb-4">
                <div className="collab-messages">
                  {COLLAB_MESSAGES.map((message) => (
                    <div key={message.id} className="py-1.5">
                      <Message m={message} onOpenThread={ignore} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="tn-sticker collab-invite">
            <div className="flex flex-col items-center text-center">
              <ServerIcon
                id="home"
                name="Home"
                initial="H"
                icon={null}
                size={74}
                className="rounded-2xl"
              />
              <p className="mt-4 text-xs font-medium text-muted-foreground">You&apos;re invited to join</p>
              <h1 className="mt-1 font-brand text-4xl leading-tight font-bold text-foreground">Home</h1>
              <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                <span>Invited by</span>
                <Avatar label={LANDING_HUMAN_AVATARS.gus} seed="co-gus" size={20} />
                <span className="font-medium text-foreground">Gus</span>
              </div>
              <Button className="mt-5 h-11 w-full rounded-xl text-base">Join server</Button>
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <div className="flex items-center -space-x-1.5">
                  <Avatar label={LANDING_HUMAN_AVATARS.gus} seed="co-gus" size={22} ringColor="var(--tn-paper-raised)" />
                  <Avatar label="avatar:beam:Alli" seed="co-alli" size={22} ringColor="var(--tn-paper-raised)" />
                  <Avatar label={LANDING_HUMAN_AVATARS.shelly} seed="co-shelly" size={22} ringColor="var(--tn-paper-raised)" />
                  <Avatar label={LANDING_HUMAN_AVATARS.tracy} seed="co-tracy" size={22} ringColor="var(--tn-paper-raised)" />
                </div>
                <span>6 members</span>
              </div>
              <p className="mt-2.5 text-xs text-muted-foreground">Free to join · leave anytime</p>
            </div>
          </div>

          <div className="tn-sticker collab-approval">
            <BotApprovalCard approval={FRIEND_APPROVAL} />
          </div>
        </CommunityPreviewProfileOwner>
      </section>

      <style jsx global>{`
        .collab-room {
          position: absolute;
          top: 34px;
          left: 34px;
          width: 840px;
          height: 560px;
        }

        .collab-messages {
          width: 86.2%;
          transform: scale(1.16);
          transform-origin: top left;
        }

        .collab-invite {
          position: absolute;
          z-index: 4;
          top: 44px;
          right: 34px;
          width: 400px;
          padding: 32px 28px 26px;
          transform: rotate(1.6deg);
        }

        .collab-approval {
          position: absolute;
          z-index: 5;
          bottom: 24px;
          left: 52px;
          width: 424px;
          padding: 0;
          overflow: hidden;
          transform: rotate(-1.4deg);
        }

        .collab-approval [data-testid="bot-approval-card"] {
          max-width: none !important;
          border: 0 !important;
          border-radius: 13px !important;
          padding: 14px 16px !important;
          background: var(--tn-paper-raised) !important;
        }
      `}</style>
    </>
  )
}
