"use client";

import { MousePointer2, Terminal } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LandingShellMotion, PrototypeSheet, BotCard } from "@/components/home/landing-shell-motion";
import { CommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation";
import { PairMachineSteps } from "@/components/community/machines/pair-machine-sheet";
import { MachineCard } from "@/components/community/machines/machine-card";
import { BotFormFields } from "@/components/community/bots/bot-form-fields";
import { BotRuntimeFields } from "@/components/community/bots/bot-runtime-fields";
import { BotMachineField } from "@/components/community/bots/bot-machine-field";
import { Button } from "@/components/ui/button";
import { SheetHeader, SheetBody, SheetFooter } from "@/components/ui/sheet";
import type { CommunityMachineSummary } from "@alook/shared";
import { DeferredDemo } from "./deferred-demo";
import styles from "./guide.module.css";

export const pairingCommand = "npx --yes @alook/daemon@latest daemon start --machine-key <YOUR_MACHINE_KEY>";
const ignore = () => {};
const machine: CommunityMachineSummary = {
  id: "tutorial-machine", hostname: "studio-mac", displayName: "Studio Mac", platform: "darwin", arch: "arm64", osRelease: "15.6", daemonVersion: "0.1.60",
  status: "online", lastSeenAt: "2026-10-27T12:00:00Z", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z",
  availableRuntimes: [{ id: "codex", status: "healthy" }, { id: "claude", status: "healthy" }],
};

function Pointer() {
  return <MousePointer2 className={styles.pointer} data-demo-pointer size={30} fill="var(--background)" />;
}

function HomeScreen({ page, children }: { page: "Machines" | "My Bots"; children: ReactNode }) {
  return <CommunityPreviewNavigation value={true}><LandingShellMotion userAvatar="avatar:beam:tutorial-gus" scene={page === "Machines" ? "machine" : "provider"} beat={0}>{children}</LandingShellMotion></CommunityPreviewNavigation>;
}

function MachineList() {
  return <div className="flex flex-1 flex-col gap-6 p-6"><header className="flex items-center justify-between"><div className="text-xl font-medium">Machines</div><Button data-connect-entry>Connect a machine</Button></header></div>;
}

function ConnectSheet() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { root.current?.querySelector('[aria-label="Copy command"]')?.setAttribute("data-copy", ""); }, []);
  return <HomeScreen page="Machines"><MachineList /><PrototypeSheet label="Connect a machine">
    <SheetHeader><div className="text-lg font-semibold">Connect a machine</div></SheetHeader>
    <SheetBody><div ref={root}><PairMachineSteps command={pairingCommand} generating={false} onCopy={ignore} connectedHostname={null} headingAs="div" /></div></SheetBody>
    <SheetFooter><Button variant="secondary">Done</Button></SheetFooter>
  </PrototypeSheet></HomeScreen>;
}

export function ConnectDemo() {
  return <DeferredDemo scene="connect" label="Connect your computer">
    <div data-demo-frame><HomeScreen page="Machines"><MachineList /></HomeScreen></div>
    <div data-demo-frame><ConnectSheet /></div>
    <div data-demo-frame><div className={styles.terminal}>
      <div className={styles.terminalHeader} data-terminal-header><Terminal size={14} />Terminal · your computer<span className={styles.keycapSlot}><span className={styles.keycap} data-paste-key>⌘ V</span><span className={styles.keycap} data-enter-key>Enter ↵</span></span></div>
      <pre className={styles.command} data-command><span className={styles.prompt}>$ </span><span data-command-text>{pairingCommand}</span><span data-terminal-newline>{"\n"}</span><span className={styles.textCaret} data-terminal-caret /></pre>
    </div></div>
    <div data-demo-frame><HomeScreen page="Machines"><div className="flex flex-1 flex-col gap-6 p-6"><div className="text-xl font-medium">Machines</div><MachineCard machine={machine} onDelete={ignore} onReconnect={ignore} /></div></HomeScreen></div>
    <Pointer />
  </DeferredDemo>;
}

function BotForm({ runtime, count }: { runtime: "codex" | "claude"; count: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ name: "", runtime: "codex" });
  useLayoutEffect(() => {
    const element = root.current!;
    const update = (event: Event) => setState((current) => ({ ...current, ...(event as CustomEvent).detail }));
    element.addEventListener("tutorial-form", update);
    element.querySelector('input[placeholder="Name your bot"]')?.setAttribute("data-name-field", "");
    element.querySelector('[data-testid="bot-machine-picker"] label')?.setAttribute("data-machine", "");
    return () => element.removeEventListener("tutorial-form", update);
  }, []);
  return <HomeScreen page="My Bots"><BotListContent count={count} /><PrototypeSheet label="Create a bot">
    <SheetHeader><div className="text-lg font-semibold">Create a bot</div></SheetHeader>
    <SheetBody><div ref={root} data-bot-form className="flex flex-col gap-6">
      <BotFormFields avatarDraft={{ kind: "procedural", image: `avatar:beam:${runtime}` }} onAvatarChange={ignore} name={state.name} setName={ignore} onShuffle={ignore} description="" setDescription={ignore} />
      <BotMachineField machines={[machine]} machineId={machine.id} onChange={ignore} radioName={`tutorial-machine-${runtime}`} />
      <BotRuntimeFields options={machine.availableRuntimes.map(({ id }) => ({ id, unhealthy: false }))} runtime={state.runtime} model={null} onRuntimeChange={ignore} onModelChange={ignore} radioName={`tutorial-runtime-${runtime}`} motionTargetPrefix="tutorial-runtime" />
    </div></SheetBody>
    <SheetFooter><Button variant="outline">Cancel</Button><Button data-create-submit>Create bot</Button></SheetFooter>
  </PrototypeSheet></HomeScreen>;
}

export function BotListContent({ count }: { count: number }) {
  return <div className="flex flex-1 flex-col gap-6 p-6"><header className="flex items-center justify-between"><div className="text-xl font-medium">My Bots</div><Button data-bot-entry>Create a bot</Button></header>
    {count > 0 && <BotCard name="Milo" runtime="codex" model={null} status="Online" />}{count > 1 && <BotCard name="Nova" runtime="claude" model={null} status="Online" />}
  </div>;
}

export function BotsDemo({ runtime }: { runtime: "codex" | "claude" }) {
  const count = runtime === "codex" ? 0 : 1;
  return <DeferredDemo scene="bots" label={runtime === "codex" ? "Create your Codex bot" : "Create your Claude Code bot"}>
    <div data-demo-frame data-bot-runtime={runtime}><HomeScreen page="My Bots"><BotListContent count={count} /></HomeScreen></div>
    <div data-demo-frame><BotForm runtime={runtime} count={count} /></div>
    <div data-demo-frame><HomeScreen page="My Bots"><BotListContent count={count + 1} /></HomeScreen></div>
    <Pointer />
  </DeferredDemo>;
}
