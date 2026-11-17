"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import { ChannelHeader } from "@/components/community/channels/channel-header";
import { ForumView } from "@/components/community/channels/forum-view";
import { LandingShellMotion } from "@/components/home/landing-shell-motion";
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation";
import { MachineCard } from "@/components/community/machines/machine-card";
import type { CommunityMachineSummary } from "@alook/shared";
import { MentionRow } from "@/components/community/messages/composer-suggestion-popups";
import { ComposerPreview } from "@/components/community/messages/composer-preview";
import { Message } from "@/components/community/messages/message";
import { TypingIndicator } from "@/components/community/messages/typing-indicator";
import type { MentionItem } from "@/lib/community/mention-extension";
import type { ForumThread, RenderMsg } from "@/lib/community/models/message";
import type { Category } from "@/lib/community/models/navigation";
import type { CommunityProfile, Member } from "@/lib/community/models/people";
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview";
import { COMPOSER_ACCESSORY_ROW_HEIGHT_PX } from "@/lib/community/conversation-layout";
import { MESSAGE_ROW_VERTICAL_PADDING_PX } from "@/lib/community/message-list-items";
import type { CSSProperties } from "react";
import { DeferredDemo } from "./deferred-demo";
import { TutorialServerShell } from "./server-demo";
import styles from "./guide.module.css";

type StoryImage = { url: string; name: string; width: number; height: number };
export type StoryStep =
  | { send: string; mentions?: readonly string[]; text: string }
  | { post: string; mentions?: readonly string[]; text: string; image?: StoryImage };
export type StoryMachine = { name: string; hostname: string; platform: "darwin" | "win32" | "linux"; runtimes: readonly string[] };

type StoryState = { shown: number; typing: string | null; mentions: number; text: string; popup: number; posted: boolean };
export type StoryForumPost = { title: string; author: string; preview: string; tags?: readonly string[] };

const ignore = () => {};
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const authorOf = (step: StoryStep) => "send" in step ? step.send : step.post;

function people(steps: readonly StoryStep[]) {
  const names = [...new Set(steps.flatMap((step) => [authorOf(step), ...(step.mentions ?? [])]))];
  return names.map((name, index) => ({ id: `story-${slug(name)}`, name, discriminator: `30${String(index + 1).padStart(2, "0")}`, avatar: `avatar:beam:${slug(name)}` }));
}

function messages(steps: readonly StoryStep[], directory: Map<string, CommunityProfile>): RenderMsg[] {
  const start = Date.parse("2026-11-16T02:00:00.000Z");
  return steps.map((step, index) => {
    const person = directory.get(`story-${slug(authorOf(step))}`)!;
    const mentions = (step.mentions ?? []).map((name) => { const target = directory.get(`story-${slug(name)}`)!; return `@${target.name}#${target.discriminator} `; }).join("");
    return { id: `story-${index}`, type: "chat", authorId: person.id, authorName: person.name, authorAvatar: person.avatar ?? undefined, content: `${mentions}${step.text}`, ...("image" in step && step.image ? { attachments: [{ kind: "image" as const, name: step.image.name, url: step.image.url, contentType: "image/webp", width: step.image.width, height: step.image.height }] } : {}), createdAt: new Date(start + index * 90_000).toISOString(), seq: index + 1, grouped: index > 0 && authorOf(steps[index - 1]) === authorOf(step) };
  });
}

function channelTree(channels: readonly string[], active: string, forum?: string): Category[] {
  return [{ id: "story-public", name: "Public", channels: channels.map((name) => ({ id: `story-${slug(name)}`, name, active: name === active, unread: false, type: name === forum ? "forum" as const : "text" as const })) }];
}

type Person = ReturnType<typeof people>[number];

function forumThread(post: StoryForumPost, author: Person, index: number, participants: readonly Person[]): ForumThread {
  return {
    id: `story-post-${index}`, name: post.title, messageCount: participants.length + 2, lastMessageAt: new Date(Date.parse("2026-11-16T02:00:00.000Z") - index * 36e5).toISOString(),
    parent: { authorName: author.name, text: post.preview }, authorId: author.id, authorAvatar: author.avatar, authorAvatarVersion: 0,
    openerMessageId: `story-opener-${index}`, tags: [...(post.tags ?? [])], preview: post.preview,
    participants: participants.map((person) => ({ id: person.id, name: person.name, avatar: person.avatar, avatarVersion: 0 })), participantCount: participants.length,
  } as unknown as ForumThread;
}

function StoryForum({ channel, channels, steps, post, earlier }: { channel: string; channels: readonly string[]; steps: readonly StoryStep[]; post: StoryForumPost; earlier: readonly StoryForumPost[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [posted, setPosted] = useState(true);
  useLayoutEffect(() => {
    const element = root.current!;
    const update = (event: Event) => { const detail = (event as CustomEvent<Partial<StoryState>>).detail; if (detail.posted !== undefined) setPosted(detail.posted); };
    element.addEventListener("story-state", update);
    return () => element.removeEventListener("story-state", update);
  }, []);
  const roster = people([...steps, ...[post, ...earlier].map((entry) => ({ post: entry.author, text: "" }))]);
  const find = (name: string) => roster.find((person) => person.name === name)!;
  const members = roster.map((person) => ({ userId: person.id, name: person.name, discriminator: person.discriminator, avatar: person.avatar, avatarVersion: 0 })) as unknown as Member[];
  const posts = [...(posted ? [forumThread(post, find(post.author), 0, roster.filter((person) => steps.some((step) => authorOf(step) === person.name)))] : []), ...earlier.map((entry, index) => forumThread(entry, find(entry.author), index + 1, [find(entry.author)]))];
  const directory = new Map<string, CommunityProfile>(roster.map((person) => [person.id, person]));
  return <TutorialServerShell server channels={channelTree(channels, channel, channel)}><CommunityPreviewProfileOwner profiles={directory}>
    <ChannelHeader channel={channel} kind="forum" rightPanel={null} onToggle={ignore} />
    <div ref={root} data-story-forum className="flex min-h-0 flex-1 flex-col">
      <ForumView forumChannelId={`story-${slug(channel)}`} members={members} posts={posts} tag="All" onTagChange={ignore} availableTags={[...new Set([post, ...earlier].flatMap((entry) => entry.tags ?? []))]} tagsKnown onOpenPost={ignore} />
    </div>
  </CommunityPreviewProfileOwner></TutorialServerShell>;
}

function StoryMachines({ machines }: { machines: readonly StoryMachine[] }) {
  const summaries = machines.map((machine, index): CommunityMachineSummary => ({
    id: `story-machine-${index}`, hostname: machine.hostname, displayName: machine.name, platform: machine.platform, arch: machine.platform === "darwin" ? "arm64" : "x64", osRelease: machine.platform === "darwin" ? "15.6" : "10.0.26100", daemonVersion: "0.1.69",
    status: "online", lastSeenAt: "2026-11-16T02:00:00Z", createdAt: "2026-11-01T02:00:00Z", updatedAt: "2026-11-16T02:00:00Z",
    availableRuntimes: machine.runtimes.map((id) => ({ id, status: "healthy" })),
  }) as CommunityMachineSummary);
  return <CommunityPreviewNavigation value={true}><LandingShellMotion userAvatar="avatar:beam:tutorial-gus" scene="machine" beat={0}>
    <div className="flex flex-1 flex-col gap-6 p-6" data-story-machine-list>
      <header className="text-xl font-medium">Machines</header>
      <div className="grid gap-4">{summaries.map((machine) => <MachineCard key={machine.id} machine={machine} onDelete={ignore} onReconnect={ignore} />)}</div>
    </div>
  </LandingShellMotion></CommunityPreviewNavigation>;
}

function StoryChannel({ channel, channels, steps, title }: { channel: string; channels: readonly string[]; steps: readonly StoryStep[]; title?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<StoryState>({ shown: steps.length, typing: null, mentions: 0, text: "", popup: -1, posted: true });
  useLayoutEffect(() => {
    const element = root.current!;
    const update = (event: Event) => setState((value) => ({ ...value, ...(event as CustomEvent).detail }));
    element.addEventListener("story-state", update);
    return () => element.removeEventListener("story-state", update);
  }, []);
  const roster = people(steps);
  const directory = new Map<string, CommunityProfile>(roster.map((person) => [person.id, person]));
  const rendered = messages(steps, directory);
  const sendStep = steps[state.shown];
  const draftMentions: MentionItem[] = sendStep && "send" in sendStep ? (sendStep.mentions ?? []).map((name) => {
    const person = roster.find((entry) => entry.name === name)!;
    return { kind: "member", id: person.id, userId: person.id, label: `${person.name}#${person.discriminator}`, name: person.name, discriminator: person.discriminator, avatar: person.avatar, status: "online" };
  }) : [];
  const hasText = state.mentions > 0 || Boolean(state.text);
  return <TutorialServerShell server channels={channelTree(channels, channel, title ? channel : undefined)}><CommunityPreviewProfileOwner profiles={directory}>
    {/* An opened forum post is a thread in the app: thread header with an always-visible back arrow. */}
    <ChannelHeader channel={title ?? channel} kind={title ? "thread" : "text"} rightPanel={null} onToggle={ignore} {...(title ? { mobileBack: ignore, mobileBackDisplay: "always" as const } : {})} />
    <div ref={root} data-story-channel data-story-steps={JSON.stringify(steps)} className="flex min-h-0 flex-1 flex-col" style={{ "--story-row-padding": `${MESSAGE_ROW_VERTICAL_PADDING_PX}px`, "--story-accessory-height": `${COMPOSER_ACCESSORY_ROW_HEIGHT_PX}px` } as CSSProperties}>
      <div className={styles.storyMessages}>
        {rendered.map((message, index) => <div key={message.id} data-story-message={index} data-visible={index < state.shown} data-grouped={message.grouped} className={styles.storySlot}><Message m={message} onOpenThread={ignore} /></div>)}
      </div>
      <div className={styles.storyTyping}>{state.typing && <TypingIndicator names={[state.typing]} />}</div>
      <div className={styles.storyComposer} data-message-composer data-tutorial-panel>
        {draftMentions.map((item, index) => <div key={item.id} data-mention-choice={index} className={styles.mentionMenu} style={{ visibility: state.popup === index ? "visible" : "hidden" }}><MentionRow item={item} selected showMembersHeader={false} onSelect={ignore} /></div>)}
        <ComposerPreview hasText={hasText}>
          <div className="min-h-6 text-base chat-input-line-height" data-tutorial-editor>
            {!hasText && <span className="text-muted-foreground">Message /{channel}</span>}
            {draftMentions.slice(0, state.mentions).map((item) => <span key={item.id}><span className="mention-highlight">@{item.label.replace(/#\d+$/, "")}</span>{" "}</span>)}
            <span>{state.text}</span>{hasText && <span className={styles.textCaret} />}
          </div>
        </ComposerPreview>
      </div>
    </div>
  </CommunityPreviewProfileOwner></TutorialServerShell>;
}

export function StoryDemo({ label, channel, channels = [channel], steps, forumPost, earlierPosts = [], openPost, machines }: { label: string; channel: string; channels?: readonly string[]; steps: readonly StoryStep[]; forumPost?: StoryForumPost; earlierPosts?: readonly StoryForumPost[]; openPost?: string; machines?: readonly StoryMachine[] }) {
  return <DeferredDemo scene="story" label={label}>
    {machines && <div data-demo-frame data-story-machines><StoryMachines machines={machines} /></div>}
    {forumPost && <div data-demo-frame data-story-list><StoryForum channel={channel} channels={channels} steps={steps} post={forumPost} earlier={earlierPosts} /></div>}
    <div data-demo-frame data-story-thread><StoryChannel channel={channel} channels={channels} steps={steps} title={forumPost?.title ?? openPost} /></div>
    <MousePointer2 className={styles.pointer} data-demo-pointer size={30} fill="var(--background)" />
  </DeferredDemo>;
}
