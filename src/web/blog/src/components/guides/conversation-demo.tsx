"use client";

import { ChannelHeader } from "@/components/community/channels/channel-header";
import { Message } from "@/components/community/messages/message";
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview";
import type { CommunityProfile } from "@/lib/community/models/people";
import type { RenderMsg } from "@/lib/community/models/message";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { TutorialServerShell } from "./server-demo";
import styles from "./guide.module.css";

const ignore = () => {};
export type ConversationLine = readonly [author: string, text: string];

function profilesFor(lines: readonly ConversationLine[]) {
  const names = [...new Set(lines.map(([author]) => author))];
  return new Map<string, CommunityProfile>(names.map((name, index) => {
    const id = `conversation-${name.toLowerCase()}`;
    return [id, { id, name, discriminator: `20${String(index + 1).padStart(2, "0")}`, avatar: `avatar:beam:${name.toLowerCase()}` }];
  }));
}

function toMessages(lines: readonly ConversationLine[], profiles: Map<string, CommunityProfile>): RenderMsg[] {
  const start = Date.parse("2026-11-16T02:00:00.000Z");
  return lines.map(([author, text], index) => {
    const person = profiles.get(`conversation-${author.toLowerCase()}`)!;
    return { id: `conversation-${index}`, type: "chat", authorId: person.id, authorName: person.name, authorAvatar: person.avatar ?? undefined, content: text, createdAt: new Date(start + index * 120_000).toISOString(), seq: index + 1, grouped: false };
  });
}

export function ConversationDemo({ label, lines, channel = "general" }: { label: string; lines: readonly ConversationLine[]; channel?: string }) {
  const profiles = profilesFor(lines);
  return <figure className={styles.demo} aria-label={label}>
    <div className={`${technostalgia.theme} ${styles.stage} ${styles.conversationStage}`} inert>
      <div data-demo-frame>
        <TutorialServerShell server><CommunityPreviewProfileOwner profiles={profiles}>
          <ChannelHeader channel={channel} kind="text" rightPanel={null} onToggle={ignore} />
          <div className={styles.conversation}>{toMessages(lines, profiles).map((message) => <Message key={message.id} m={message} onOpenThread={ignore} />)}</div>
        </CommunityPreviewProfileOwner></TutorialServerShell>
      </div>
    </div>
    <figcaption className="sr-only">{lines.map(([author, text]) => `${author}: ${text}`).join(" ")}</figcaption>
  </figure>;
}
