"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { ChannelHeader } from "@/components/community/channels/channel-header";
import { MentionRow } from "@/components/community/messages/composer-suggestion-popups";
import { Message } from "@/components/community/messages/message";
import { type MentionItem } from "@/lib/community/mention-extension";
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview";
import type { CommunityProfile } from "@/lib/community/models/people";
import type { RenderMsg } from "@/lib/community/models/message";
import { TutorialServerShell } from "./server-demo";
import { ComposerPreview } from "@/components/community/messages/composer-preview";
import { DeferredDemo } from "./deferred-demo";
import styles from "./guide.module.css";

const ignore = () => {};
export const tutorialTask = "Agree on roles, then wait for my task.";
const bots: MentionItem[] = ["Milo", "Nova"].map((name, index) => ({ kind: "member", id: `tutorial-${name.toLowerCase()}`, userId: `tutorial-${name.toLowerCase()}`, label: `${name}#100${index + 1}`, name, discriminator: `100${index + 1}`, avatar: `avatar:beam:${name.toLowerCase()}`, status: "online" }));
const profiles = new Map<string, CommunityProfile>([["gus", { id: "gus", name: "Gus", avatar: "avatar:beam:tutorial-gus" }]]);
const sentMessage: RenderMsg = { id: "tutorial-sent-message", type: "chat", authorId: "gus", authorName: "Gus", authorAvatar: "avatar:beam:tutorial-gus", content: `@Milo#1001 @Nova#1002 ${tutorialTask}`, createdAt: "2026-10-28T04:00:00.000Z", seq: 1, grouped: false };
type DraftState = { mentions: number; text: string; popup: number };

function MessageChannel({ sent = false }: { sent?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftState>({ mentions: 0, text: "", popup: -1 });
  useLayoutEffect(() => {
    const element = root.current!;
    const update = (event: Event) => setDraft(value => ({ ...value, ...(event as CustomEvent).detail }));
    element.addEventListener("tutorial-draft", update);
    return () => element.removeEventListener("tutorial-draft", update);
  }, []);
  const hasText = draft.mentions > 0 || Boolean(draft.text);
  return <TutorialServerShell server><CommunityPreviewProfileOwner profiles={profiles}>
    <ChannelHeader channel="general" kind="text" rightPanel={null} onToggle={ignore} />
    <div ref={root} data-message-channel className="flex min-h-0 flex-1 flex-col justify-end">
      {sent && <div className={styles.messageResult} data-message-result><Message m={sentMessage} onOpenThread={ignore} /></div>}
      <div className={styles.messageComposer} data-message-composer data-tutorial-panel>
        {bots.map((bot, index) => <div key={bot.id} data-mention-choice={index} className={styles.mentionMenu} style={{ visibility: draft.popup === index ? "visible" : "hidden" }}><MentionRow item={bot} selected showMembersHeader={false} onSelect={ignore} /></div>)}
        <ComposerPreview hasText={hasText}>
          <div className="min-h-6 text-base chat-input-line-height" data-tutorial-editor>
            {!hasText && <span className="text-muted-foreground">Message /general</span>}
            {bots.slice(0, draft.mentions).map(bot => <span key={bot.id}><span className="mention-highlight">@{bot.label.replace(/#\d+$/, "")}</span>{" "}</span>)}
            <span data-draft-text>{draft.text}</span>{hasText && <span className={styles.textCaret} data-message-caret />}
          </div>
        </ComposerPreview>
      </div>
    </div>
  </CommunityPreviewProfileOwner></TutorialServerShell>;
}

export function MessageDemo() {
  return <DeferredDemo scene="message" label="Send your first message">
    <div data-demo-frame data-motion-center-y><MessageChannel /></div>
    <div data-demo-frame data-motion-center-y><MessageChannel sent /></div>
    <MousePointer2 className={styles.pointer} data-demo-pointer size={30} fill="var(--background)" />
  </DeferredDemo>;
}
