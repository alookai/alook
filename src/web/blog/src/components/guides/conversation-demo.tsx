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
const people: CommunityProfile[] = [
  { id: "gus", name: "Gus", avatar: "avatar:beam:tutorial-gus" },
  { id: "tutorial-milo", name: "Milo", discriminator: "1001", avatar: "avatar:beam:milo", kind: "bot" },
  { id: "tutorial-nova", name: "Nova", discriminator: "1002", avatar: "avatar:beam:nova", kind: "bot" },
];
const profiles = new Map(people.map((person) => [person.id, person]));

export type ConversationLine = readonly [author: "gus" | "milo" | "nova", text: string];

function toMessages(lines: readonly ConversationLine[]): RenderMsg[] {
  const start = Date.parse("2026-11-16T02:00:00.000Z");
  return lines.map(([author, text], index) => {
    const person = profiles.get(author === "gus" ? "gus" : `tutorial-${author}`)!;
    return { id: `conversation-${index}`, type: "chat", authorId: person.id, authorName: person.name, authorAvatar: person.avatar ?? undefined, content: text, createdAt: new Date(start + index * 120_000).toISOString(), seq: index + 1, grouped: false };
  });
}

export function ConversationDemo({ label, lines }: { label: string; lines: readonly ConversationLine[] }) {
  return <figure className={styles.demo} aria-label={label}>
    <div className={`${technostalgia.theme} ${styles.stage} ${styles.conversationStage}`} inert>
      <div data-demo-frame>
        <TutorialServerShell server><CommunityPreviewProfileOwner profiles={profiles}>
          <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={ignore} />
          <div className={styles.conversation}>{toMessages(lines).map((message) => <Message key={message.id} m={message} onOpenThread={ignore} />)}</div>
        </CommunityPreviewProfileOwner></TutorialServerShell>
      </div>
    </div>
    <figcaption className="sr-only">{lines.map(([author, text]) => `${author}: ${text}`).join(" ")}</figcaption>
  </figure>;
}
