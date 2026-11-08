import React, { useState, useLayoutEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CurrentUserProvider } from "@/contexts/community/current-user";
import { ProductComposer } from "./ProductComposer";
import { Shell } from "@/components/community/shell/shell";
import { ServerRail } from "@/components/community/shell/server-rail";
import { ChannelSidebarTreeOwner } from "@/components/community/channels/channel-sidebar-tree-owner";


import { ChannelHeader } from "@/components/community/channels/channel-header";
import {messageMotion,playbackAge} from "./message-motion";
import { VideoMessage } from "./VideoMessage";
import { UserBar } from "@/components/community/shell/user-bar";
import { AppSurface } from "@/components/ui/app-surface";
import { CommunityPreviewProfileOwner } from "@/stores/community/profile-preview";
import { GeneratedAvatar } from "@/components/avatar/generated-avatar";
import { ProviderLogo } from "@/components/provider-logo";
import { staticFile, delayRender, continueRender } from "remotion"
import type { RenderMsg } from "@/lib/community/models/message";

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
export type ChatLine = {
  anchor?: string;
  at: number;
  name: string;
  text: string;
  memory?: string;
  memoryAt?: number;
  clock?: string;
};
export function Product({
  t,
  home = false,
  lines,
  composerText,
  sourceTime=t,
  realtimeMotion=false,
}: {
  t: number;
  home?: boolean;
  lines: ChatLine[];
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
  const visible = lines.filter((m) => t >= m.at);
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
  const channel = home ? "family" : "launch";
  return (
    <QueryClientProvider client={client}><CurrentUserProvider initialUser={{id:"Lin",name:"Lin",email:"lin@example.test",avatar:avatarSource("Lin")}}>
      <CommunityPreviewProfileOwner profiles={profiles}>
        <div className="product-viewport">
          <Shell style={{ position: "absolute" }}>
            <ServerRail
              servers={servers}
              folders={[]}
              activeServerId={home ? "Home" : "Studio"}
              view="server"
              bottomInset={60}
              onHome={noop}
              onServer={noop}
              onServerNavigate={noop}
            />
            <div className="relative flex min-w-0 flex-1 flex-col pt-2">
              <AppSurface className="rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none border-l border-t border-border/40 shadow-none ring-0">
                <div className="flex min-h-0 flex-1">
                  <div className="flex w-60 shrink-0 flex-col bg-sidebar pb-14">
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
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col bg-background">
                    <ChannelHeader
                        channel={channel}
                        kind="text"
                        rightPanel={null}
                        onToggle={noop}
                    />
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
                              data-message-anchor={line.anchor}
                              key={line.at}
                              style={{translate:`0 ${messageMotion(motionAge(line.at)).y}px`,opacity:messageMotion(motionAge(line.at)).opacity}}
                            >
                              <VideoMessage m={m} memory={line.memory} memoryAge={line.memoryAt===undefined?undefined:t-line.memoryAt} />

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
