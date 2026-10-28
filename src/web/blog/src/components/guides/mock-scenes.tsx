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
import { requiresExplicitModel } from "@alook/shared";
import type { CommunityMachineSummary } from "@alook/shared";
import { defaultTutorialPair, tutorialAgents, type TutorialPair, type TutorialRuntime } from "@/lib/step-guides";
import { DeferredDemo } from "./deferred-demo";
import styles from "./guide.module.css";

export const pairingCommand = "npx --yes @alook/daemon@latest daemon start --machine-key <YOUR_MACHINE_KEY>";
export const tutorialModel = "provider/model-id";
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

export function ConnectDemo({ agents = defaultTutorialPair }: { agents?: TutorialPair }) {
  return <DeferredDemo scene="connect" label="Connect your computer">
    <div data-demo-frame><HomeScreen page="Machines"><MachineList /></HomeScreen></div>
    <div data-demo-frame><ConnectSheet /></div>
    <div data-demo-frame><div className={styles.terminal}>
      <div className={styles.terminalHeader} data-terminal-header><Terminal size={14} />Terminal · your computer<span className={styles.keycapSlot}><span className={styles.keycap} data-paste-key>⌘ V</span><span className={styles.keycap} data-enter-key>Enter ↵</span></span></div>
      <pre className={styles.command} data-command><span className={styles.prompt}>$ </span><span data-command-text>{pairingCommand}</span><span data-terminal-newline>{"\n"}</span><span className={styles.textCaret} data-terminal-caret /></pre>
    </div></div>
    <div data-demo-frame><HomeScreen page="Machines"><div className="flex flex-1 flex-col gap-6 p-6"><div className="text-xl font-medium">Machines</div><MachineCard machine={{ ...machine, availableRuntimes: agents.map(id => ({ id, status: "healthy" })) }} onDelete={ignore} onReconnect={ignore} /></div></HomeScreen></div>
    <Pointer />
  </DeferredDemo>;
}

function BotForm({ runtime, count, agents }: { runtime: TutorialRuntime; count: number; agents: TutorialPair }) {
  const root = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ name: string; runtime: TutorialRuntime; model: string | null; modelOpen: boolean }>({ name: "", runtime: agents[0], model: null, modelOpen: false });
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = root.current!;
    const update = (event: Event) => setState((current) => ({ ...current, ...(event as CustomEvent).detail }));
    element.addEventListener("tutorial-form", update);
    element.querySelector('input[placeholder="Name your bot"]')?.setAttribute("data-name-field", "");
    element.querySelector('[data-testid="bot-machine-picker"] label')?.setAttribute("data-machine", "");
    return () => element.removeEventListener("tutorial-form", update);
  }, []);
  return <HomeScreen page="My Bots"><BotListContent count={count} agents={agents} /><PrototypeSheet label="Create a bot">
    <SheetHeader><div className="text-lg font-semibold">Create a bot</div></SheetHeader>
    <SheetBody><div ref={root} data-bot-form className="flex flex-col gap-6">
      <BotFormFields avatarDraft={{ kind: "procedural", image: `avatar:beam:${runtime}` }} onAvatarChange={ignore} name={state.name} setName={ignore} onShuffle={ignore} description="" setDescription={ignore} />
      <BotMachineField machines={[{ ...machine, availableRuntimes: agents.map(id => ({ id, status: "healthy" })) }]} machineId={machine.id} onChange={ignore} radioName={`tutorial-machine-${runtime}`} />
      <BotRuntimeFields options={agents.map(id => ({ id, unhealthy: false, ...(requiresExplicitModel(id) ? { reasoning: { updateMode: "live_next_turn" as const, models: [{ id: tutorialModel, displayName: "Example model", supportedReasoningEfforts: [] }] } } : {}) }))} runtime={state.runtime} model={state.model} modelMenu={{ open: state.modelOpen, container: menuContainer }} onRuntimeChange={ignore} onModelChange={ignore} radioName={`tutorial-runtime-${runtime}`} motionTargetPrefix="tutorial-runtime" />
      <div ref={setMenuContainer} data-model-menu />
    </div></SheetBody>
    <SheetFooter><Button variant="outline">Cancel</Button><Button data-create-submit disabled={!state.name || (requiresExplicitModel(state.runtime) && !state.model)}>Create bot</Button></SheetFooter>
  </PrototypeSheet></HomeScreen>;
}

export function BotListContent({ count, agents = defaultTutorialPair }: { count: number; agents?: TutorialPair }) {
  return <div className="flex flex-1 flex-col gap-6 p-6"><header className="flex items-center justify-between"><div className="text-xl font-medium">My Bots</div><Button data-bot-entry>Create a bot</Button></header>
    {count > 0 && <BotCard name="Milo" runtime={agents[0]} model={requiresExplicitModel(agents[0]) ? tutorialModel : null} status="Online" />}{count > 1 && <BotCard name="Nova" runtime={agents[1]} model={requiresExplicitModel(agents[1]) ? tutorialModel : null} status="Online" />}
  </div>;
}

export function BotsDemo({ runtime, agents = defaultTutorialPair }: { runtime: TutorialRuntime; agents?: TutorialPair }) {
  const count = runtime === agents[0] ? 0 : 1;
  return <DeferredDemo scene="bots" label={`Create your ${tutorialAgents[runtime].name} bot`}>
    <div data-demo-frame data-bot-runtime={runtime} data-bot-name={count === 0 ? "Milo" : "Nova"} data-initial-runtime={agents[0]}><HomeScreen page="My Bots"><BotListContent count={count} agents={agents} /></HomeScreen></div>
    <div data-demo-frame data-motion-center-y={requiresExplicitModel(runtime) ? "" : undefined}><BotForm runtime={runtime} count={count} agents={agents} /></div>
    <div data-demo-frame><HomeScreen page="My Bots"><BotListContent count={count + 1} agents={agents} /></HomeScreen></div>
    <Pointer />
  </DeferredDemo>;
}
