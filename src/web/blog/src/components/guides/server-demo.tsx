"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MousePointer2 } from "lucide-react";
import { LandingShellMotion, PrototypeComposer, PrototypeInviteSurface } from "@/components/home/landing-shell-motion";
import { sceneSnapshot } from "@/components/home/landing-shell-motion-timeline";
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation";
import { CreateServerDialog } from "@/components/community/settings/create-server-dialog";
import { ChannelHeader } from "@/components/community/channels/channel-header";
import { MemberIdentityRow } from "@/components/community/members/member-identity-row";
import { InviteFriendRow } from "@/components/community/social/invite-dialog";
import type { Server } from "@/lib/community/models/navigation";
import type { DM } from "@/lib/community/models/people";
import { defaultTutorialPair, type TutorialPair } from "@/lib/step-guides";
import { BotListContent } from "./mock-scenes";
import { DeferredDemo } from "./deferred-demo";
import styles from "./guide.module.css";

const ignore = () => {};
const inviteLink = "https://alook.ai/c/invite/EXAMPLE";
const dms: DM[] = ["Milo", "Nova"].map((name, index) => ({ id: `tutorial-dm-${name.toLowerCase()}`, userId: `tutorial-${name.toLowerCase()}`, name, discriminator: `100${index + 1}`, avatar: `avatar:beam:${name.toLowerCase()}`, avatarVersion: 0, status: "online", preview: "Available" }));
const createdServers: Server[] = [{ id: "gus", name: "Gus", initial: "G", active: false, unread: false, mentions: 0, isOwner: true, icon: null }, { id: "work", name: "Studio", initial: "S", active: true, unread: false, mentions: 0, isOwner: true, icon: null }];
const base = sceneSnapshot("provider", 0);
export function TutorialServerShell({ server = false, activeDm, children }: { server?: boolean; activeDm?: string; children?: ReactNode }) {
  return <CommunityPreviewNavigation value={true}><LandingShellMotion userAvatar="avatar:beam:tutorial-gus" scene={server ? "server" : "provider"} beat={0} previewServers={server || activeDm ? createdServers : undefined} dms={dms} activeDm={activeDm}>{children}</LandingShellMotion></CommunityPreviewNavigation>;
}
function useSceneState<T extends object>(initial: T) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState(initial);
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = (event: Event) => setState((value) => ({ ...value, ...(event as CustomEvent).detail }));
    element.addEventListener("tutorial-state", update);
    return () => element.removeEventListener("tutorial-state", update);
  }, []);
  return { ref, state };
}
function CreateServer({ agents }: { agents: TutorialPair }) {
  const { ref, state } = useSceneState({ name: "" });
  return <TutorialServerShell><BotListContent count={2} agents={agents} /><div ref={ref} data-server-form><CreateServerDialog onClose={ignore} previewName={state.name} /></div></TutorialServerShell>;
}
function ServerContent({ joined = false }: { joined?: boolean }) {
  return <><ChannelHeader channel="general" kind="text" rightPanel={joined ? "members" : null} onToggle={ignore} />
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col"><div className="flex-1" /><PrototypeComposer snapshot={base} target="server-composer" placeholder="Message /general" /></div>
      {joined && <aside className="w-60 shrink-0 border-l border-border/50 p-4"><div data-members-result><div className="mb-4 text-xs font-medium text-muted-foreground">Online — 3</div><div className="flex flex-col gap-5"><MemberIdentityRow name="Gus" avatarLabel="Gus" avatarSeed="gus" presence="online" />{dms.map(dm => <MemberIdentityRow key={dm.id} name={dm.name} discriminator={dm.discriminator} avatarLabel={dm.name} avatarSeed={dm.userId} avatarSrc={dm.avatar} presence="online" />)}</div></div></aside>}
    </div></>;
}
function Invite() {
  const { ref, state } = useSceneState({ milo: false, nova: false });
  return <TutorialServerShell server><ServerContent /><div ref={ref} data-invite-form><PrototypeInviteSurface snapshot={{ ...base, inviteOpen: true }} serverName="Studio" inviteLink={inviteLink}>{dms.map((dm, index) => <div key={dm.id} data-invite-recipient={index === 0 ? "milo" : "nova"}><InviteFriendRow friend={{ ...dm, sub: "Your bot" }} tokenReady inviting={false} invited={index === 0 ? state.milo : state.nova} onInvite={ignore} /></div>)}</PrototypeInviteSurface></div></TutorialServerShell>;
}
export function ServerDemo({ agents = defaultTutorialPair }: { agents?: TutorialPair }) {
  return <DeferredDemo scene="server" label="Bring them into a server">
    <div data-demo-frame><TutorialServerShell><BotListContent count={2} agents={agents} /></TutorialServerShell></div>
    <div data-demo-frame><CreateServer agents={agents} /></div>
    <div data-demo-frame><TutorialServerShell server><ServerContent /></TutorialServerShell></div>
    <div data-demo-frame><Invite /></div>
    <div data-demo-frame><TutorialServerShell server><ServerContent /></TutorialServerShell></div>
    <div data-demo-frame><TutorialServerShell server><ServerContent joined /></TutorialServerShell></div>
    <MousePointer2 className={styles.pointer} data-demo-pointer size={30} fill="var(--background)" />
  </DeferredDemo>;
}
