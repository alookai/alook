import React, { useState, useLayoutEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CurrentUserProvider } from "@/contexts/community/current-user";
import { ProductComposer } from "./ProductComposer";
import { Shell } from "@/components/community/shell/shell";
import { ServerRail } from "@/components/community/shell/server-rail";
import { ChannelSidebarTreeOwner } from "@/components/community/channels/channel-sidebar-tree-owner";
import { DmHeader } from "@/components/community/channels/dm-header";
import { DmSidebar } from "@/components/community/channels/dm-sidebar";
import { ChannelHeader } from "@/components/community/channels/channel-header";
import {messageMotion,playbackAge} from "./message-motion";
import { VideoMessage } from "./VideoMessage";
import { UserBar } from "@/components/community/shell/user-bar";
import { AppSurface } from "@/components/ui/app-surface";
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview";
import { GeneratedAvatar } from "@/components/avatar/generated-avatar";
import { ProviderLogo } from "@/components/provider-logo";
import { interpolate, staticFile, delayRender, continueRender } from "remotion";
import type { RenderMsg } from "@/lib/community/models/message";
import type { DM } from "@/lib/community/models/people";
import type { CommunityProfile } from "@/lib/community/models/people";
export { GeneratedAvatar, ProviderLogo };
export const names = ["Lin", "Alex", "Milo", "Nova", "Remy", "Pip", "Sam"];
export const seed = (name: string) =>
  name === "Milo"
    ? "milo-orange"
    : name === "Nova"
      ? "nova-purple"
      : name.toLowerCase();
export const avatarSource = (name: string) =>
  ["Lin", "Alex", "Sam"].includes(name)
    ? staticFile(`people/${name}.png`)
    : `avatar:beam:${seed(name)}`;
export const profiles = new Map<string, CommunityProfile>(
  names.map((name) => [
    name,
    {
      id: name,
      name,
      avatar: avatarSource(name),
      kind: ["Milo", "Nova", "Remy", "Pip"].includes(name) ? "bot" : "human",
    },
  ]),
);
const noop = () => {};
const miloDm: DM = {
  id: "milo-dm",
  userId: "milo-orange",
  name: "Milo",
  discriminator: "2048",
  avatar: avatarSource("Milo"),
  avatarVersion: 0,
  preview: "",
  status: "online",
  unread: false,
};
export type ChatLine = {
  at: number;
  name: string;
  text: string;
  preview?: boolean;
  memory?: string;
  memoryAt?: number;
  clock?: string;
};
export const workLines: ChatLine[] = [
  { at: 18.25, name: "Lin", text: "Alex, meet Milo." },
  {
    at: 19,
    name: "Alex",
    text: "Below the headline. Show me the mobile version.",
  },
  {
    at: 20.55,
    name: "Milo",
    text: "Here’s the mobile version.",
    preview: true,
  },
  { at: 22.2, name: "Alex", text: "That works." },
  { at: 25.85, name: "Alex", text: "The headline needs work, too." },
  {
    at: 29.55,
    name: "Lin",
    text: "Milo, keep going on the page. Nova, help with the copy.",
  },
  { at: 31, name: "Nova", text: "“Your next good idea starts here.”" },
  { at: 32, name: "Alex", text: "Love it. Let’s use that." },
  { at: 33, name: "Milo", text: "Updated the page.", preview: true },
  {
    at: 39.3,
    name: "Lin",
    text: "I’m tied up with this launch page all afternoon.",
  },
  { at: 40.5, name: "Milo", text: "I’ll keep working on the mobile layout." },
];
export const homeLines: ChatLine[] = [
  { at: 42.8, name: "Sam", text: "Is Lin free?" },
  { at: 44.3, name: "Milo", text: "He’s busy right now." },
];
export function LaunchPreview({
  updated = false,
  small = false,
}: {
  updated?: boolean;
  small?: boolean;
}) {
  return (
    <div className={"launch-preview " + (small ? "small" : "")}>
      <div className="preview-nav">
        FIELDNOTES <span>Ideas, together.</span>
      </div>
      <div className="preview-copy">
        {updated
          ? "Your next good idea starts here."
          : "A little space for your next idea."}
      </div>
      <div className="preview-button">Join the waitlist ↗</div>
      <div className="preview-art">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
export function Product({
  t,
  home = false,
  permission = false,
  lines,
  composerText,
  sourceTime=t,
  realtimeMotion=false,
}: {
  t: number;
  home?: boolean;
  permission?: boolean;
  lines?: ChatLine[];
  composerText?: string;
  sourceTime?: number;
  realtimeMotion?: boolean;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: Infinity, retry: false, enabled: false },
        },
      }),
  );
  const entries = lines ?? (permission
    ? [
        {
          at: 35,
          name: "Lin",
          text: "You can let my family know when I’m busy. Keep work details private.",
        },
      ]
    : home
      ? homeLines
      : workLines);
  const visible = entries.filter((m) => t >= m.at);
  const keep = visible;
  const scroll = useRef<HTMLDivElement>(null);
  const contents = useRef<HTMLDivElement>(null);
  const [scrollY, setScrollY] = useState(0);
  const [previousScrollY,setPreviousScrollY]=useState(0);
  const motionAge=(at:number)=>realtimeMotion?Math.max(0,t-at):playbackAge(sourceTime,t-at);
  const latestAge=keep.length?motionAge(keep[keep.length-1].at):1;
  const scrollProgress=1-Math.pow(1-Math.min(1,latestAge/.35),3);
  useLayoutEffect(() => {
    const handle = delayRender("Settle product message layout");
    let active = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      continueRender(handle);
    };
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      await document.fonts.ready;
      // Product avatars use a load-status wrapper. Prime their images before
      // its effects settle so an export starting mid-story has no blank faces.
      await Promise.all(["Lin", "Alex", "Sam"].map(name => new Promise<void>((resolve, reject) => {
        const image = new globalThis.Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Avatar failed to load: ${name}`));
        image.src = avatarSource(name);
        if (image.complete && image.naturalWidth > 0) resolve();
      })));
      await nextFrame();
      await nextFrame();
      if (active) {
        const el = scroll.current, inner = contents.current;
        if (el && inner) {
          setScrollY(Math.max(0, inner.offsetHeight-el.clientHeight+60));
          const last=inner.lastElementChild as HTMLElement|null;
          setPreviousScrollY(Math.max(0,inner.offsetHeight-(last?.offsetHeight??0)-el.clientHeight+60));
        }
      }
      await nextFrame();
      release();
    };
    void settle();
    return () => { active = false; release(); };
  }, [t, keep.length]);
  const servers = ["Studio", "Home"].map((name, i) => ({
    id: name,
    name,
    initial: name[0],
    active: name === (home ? "Home" : "Studio"),
    unread: false,
    mentions: 0,
    isOwner: true,
    icon: name === "Home" ? staticFile("people/Home.png") : null,
  }));
  const channel = permission ? "Milo" : home ? "family" : "launch";
  return (
    <QueryClientProvider client={client}><CurrentUserProvider initialUser={{id:"Lin",name:"Lin",email:"lin@example.test",avatar:avatarSource("Lin")}}>
      <CommunityPreviewProfileOwner profiles={profiles}>
        <div className="product-viewport">
          <Shell style={{ position: "absolute" }}>
            <ServerRail
              servers={servers}
              folders={[]}
              activeServerId={home ? "Home" : "Studio"}
              view={permission ? "dm" : "server"}
              bottomInset={60}
              onHome={noop}
              onServer={noop}
              onServerNavigate={noop}
            />
            <div className="relative flex min-w-0 flex-1 flex-col pt-2">
              <AppSurface className="rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none border-l border-t border-border/40 shadow-none ring-0">
                <div className="flex min-h-0 flex-1">
                  <div className="flex w-60 shrink-0 flex-col bg-sidebar pb-14">
                    <>
                      {permission ? (
                        <DmSidebar
                          dms={[miloDm]}
                          activeDm="milo-dm"
                          onPickDm={noop}
                          onShowFriends={noop}
                          onShowMachines={noop}
                          onShowBots={noop}
                        />
                      ) : (
                        <ChannelSidebarTreeOwner
                          scopeKey={`gtm-${channel}`}
                          categories={[
                            {
                              id: "project",
                              name: home ? "Family" : "Team",
                              channels: [
                                {
                                  id: channel,
                                  name: channel,
                                  active: true,
                                  unread: false,
                                  type: "text",
                                },
                              ],
                            },
                          ]}
                          serverId={home ? "Home" : "Studio"}
                          onInvitePopoverOpenChange={noop}
                          serverName={home ? "Home" : "Studio"}
                          activeChannel={channel}
                          setActiveChannel={noop}
                          isAdmin={false}
                          currentUserId="Lin"
                        />
                      )}
                    </>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col bg-background">
                    {permission ? (
                      <DmHeader dm={miloDm} />
                    ) : (
                      <ChannelHeader
                        channel={channel}
                        kind="text"
                        rightPanel={null}
                        onToggle={noop}
                      />
                    )}
                    <div className="chat-content" ref={scroll}>
                      <div
                        ref={contents}
                        style={{ transform: `translateY(${-previousScrollY-(scrollY-previousScrollY)*scrollProgress}px)` }}
                      >
                        {keep.map((line, i) => {
                          const m: RenderMsg = {
                            id: `${line.at}`,
                            type: "chat",
                            authorId: line.name,
                            authorName: line.name,
                            authorAvatar: avatarSource(line.name),
                            content: line.text,
                            createdAt: line.clock ?? "2026-09-15T06:00:00Z",
                            seq: i + 1,
                            grouped: false,
                          };
                          return (
                            <div
                              className="chat-line"
                              data-message-text={line.text}
                              key={line.at}
                              style={{translate:`0 ${messageMotion(motionAge(line.at)).y}px`,opacity:messageMotion(motionAge(line.at)).opacity}}
                            >
                              <VideoMessage m={m} memory={line.memory} memoryAge={line.memoryAt===undefined?undefined:t-line.memoryAt} />
                              {line.preview && (
                                <div className="attachment-preview">
                                  <LaunchPreview small updated={t > 32.5} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <ProductComposer channel={channel} text={composerText}/>
                  </div>
                </div>
              </AppSurface>
              <div className="absolute bottom-0 left-0 z-10 -ml-14 w-74">
                <UserBar
                  breakpoint="desktop"
                  user={{ id: "Lin", name: "Lin", avatar: avatarSource("Lin") }}
                  onEditProfile={noop}
                  inbox={<span />}
                  hasUnread={false}
                  inboxOpen={false}
                  onInboxOpenChange={noop}
                />
              </div>
            </div>
          </Shell>
        </div>
      </CommunityPreviewProfileOwner>
    </CurrentUserProvider></QueryClientProvider>
  );
}
