import { Bot, Check, ChevronDown, Circle, Dices, Laptop, MousePointer2, Plus, Settings, Shield, Terminal, Users } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { Shell } from "@/components/community/shell/shell";
import { AppRail } from "@/components/ui/app-surface";
import { ProviderLogo } from "@/components/provider-logo";
import { DeferredDemo } from "./deferred-demo";
import styles from "./guide.module.css";

export const pairingCommand = "npx --yes @alook/daemon@latest daemon start --machine-key <YOUR_MACHINE_KEY>";

function Online() {
  return <span className={styles.online}><Circle size={7} fill="currentColor" />Online</span>;
}

export function SignInMock() {
  return <figure className={styles.staticDemo}>
    <div className={styles.mock} aria-hidden="true">
      <div className={styles.mockTitle}>Sign in</div>
      <div className={styles.mockSub}>or create an account to get started</div>
      <div className={styles.mockInput}>you@example.com</div>
      <div className={styles.mockOutline}>Send Code</div>
    </div>
  </figure>;
}

function Pointer() {
  return <MousePointer2 className={styles.pointer} data-demo-pointer size={26} fill="var(--background)" />;
}

function HomeScreen({ page, children }: { page: "Machines" | "My Bots"; children: ReactNode }) {
  return <Shell className={styles.homeScreen} style={{ position: "relative", inset: "auto" }}>
    <AppRail className={styles.homeRail}><Image src="/alook.svg" alt="" width={28} height={28} /><span className={styles.railServer}>S</span><Plus size={18} /></AppRail>
    <div className={styles.homeSurface}>
      <aside className={styles.homeNav}>
        <span><Users size={16} />Friends</span>
        <span data-active={page === "Machines"}><Laptop size={16} />Machines</span>
        <span data-active={page === "My Bots"}><Bot size={16} />My Bots</span>
        <span><Shield size={16} />Privacy</span>
        <div className={styles.dmHeading}>Direct Messages</div>
        <span className={styles.dmEmpty}>Your direct messages will appear here.</span>
        <div className={styles.homeUser}><span className={styles.railServer}>S</span>Sam<Settings size={14} /></div>
      </aside>
      <div className={styles.homePanel}><div className={styles.mockTitle}>{page}</div>{children}</div>
    </div>
  </Shell>;
}

export function ConnectDemo() {
  return <DeferredDemo scene="connect" label="Connect your computer">
    <div data-demo-frame><HomeScreen page="Machines"><span className={styles.mockButton} data-connect-entry>Connect a machine</span></HomeScreen></div>
    <div data-demo-frame>
      <div className={styles.mock}>
        <div className={styles.mockTitle}><Laptop size={20} />Connect a machine</div>
        <div className={styles.mockSub}>Run this on your machine</div>
        <div className={styles.inviteUrl}>{pairingCommand}</div>
        <div className={styles.mockFooter}><span className={styles.mockButton} data-copy><span data-copy-label>Copy</span><span data-copied hidden>Copied</span></span></div>
      </div>
    </div>
    <div data-demo-frame>
      <div className={styles.terminal}>
        <div className={styles.terminalHeader}><Terminal size={14} />Terminal · your computer<span className={styles.keycap} data-paste-key>⌘ V</span><span className={styles.keycap} data-enter-key>Enter ↵</span></div>
        <pre className={styles.command} data-command><span className={styles.prompt}>$ </span><span data-command-text>{pairingCommand}</span><span className={styles.textCaret} data-terminal-caret /></pre>
      </div>
    </div>
    <div data-demo-frame><HomeScreen page="Machines"><div className={styles.botRow}><Laptop size={24} /><div><strong>Studio Mac</strong></div><span className="ml-auto"><Online /></span></div></HomeScreen></div>
    <Pointer />
  </DeferredDemo>;
}

function BotForm({ runtime, name }: { runtime: "codex" | "claude"; name: string }) {
  return <div className={styles.mock}>
    <div className={styles.mockTitle}>Create a bot</div>
    <div className={styles.botIdentity}><span className={styles.botIcon}><Bot size={20} /></span><div className={styles.botName} data-name-field><span className={styles.nameValue}><span data-name>{name}</span><span className={styles.namePlaceholder} data-name-placeholder>Name</span></span><Dices size={16} /></div><div className={styles.mockSub}>What is this bot for?</div></div>
    <div className={styles.formGroup}><span>Machine</span><div className={styles.radioOption} data-machine data-selected="true"><span className={styles.radioDot} />Studio Mac<span className="ml-auto"><Online /></span></div></div>
    <div className={styles.formGroup} data-runtime><span>Runtime</span>{(["codex", "claude"] as const).map((option) => <div key={option} className={styles.radioOption} data-option={option} data-selected={option === runtime}>
      <span className={styles.radioDot} /><ProviderLogo provider={option} className="size-4" />{option}
    </div>)}</div>
    <div className={styles.formGroup}><span>Model</span><div className={styles.modelOption}>Default ({runtime}&apos;s own default)<ChevronDown size={12} /></div></div>
    <div className={styles.formGroup}><span>Reasoning effort</span><div className={styles.modelOption}>Default<ChevronDown size={12} /></div></div>
    <div className={styles.mockFooter}><span>Cancel</span><span className={styles.mockButton} data-create-submit>Create bot</span></div>
  </div>;
}

function BotList({ count }: { count: number }) {
  return <HomeScreen page="My Bots"><span className={styles.mockButton} data-bot-entry>Create a bot</span>
    {count > 0 && <BotRow name="Milo" detail="codex" />}{count > 1 && <BotRow name="Nova" detail="claude" />}
  </HomeScreen>;
}

export function BotsDemo() {
  return <DeferredDemo scene="bots" label="Create your two bots">
    <div data-demo-frame><BotList count={0} /></div>
    <div data-demo-frame><BotForm runtime="codex" name="Milo" /></div>
    <div data-demo-frame><BotList count={1} /></div>
    <div data-demo-frame><BotForm runtime="claude" name="Nova" /></div>
    <div data-demo-frame><BotList count={2} /></div>
    <Pointer />
  </DeferredDemo>;
}

function BotRow({ name, detail }: { name: string; detail: string }) {
  return <div className={styles.botRow}><span className={styles.botIcon}><Bot size={18} /></span><div><strong>{name}</strong><small>{detail}</small></div><Check className="ml-auto" size={16} /></div>;
}

export function InviteMock() {
  return <figure className={styles.staticDemo}>
    <div className={styles.mock} aria-hidden="true">
      <div className={styles.mockTitle}>Invite friends to Studio</div>
      <div className={styles.invite}>
        <div className={styles.inviteUrl}>https://alook.ai/c/invite/EXAMPLE</div>
        <div className={styles.mockFooter}><span className={styles.mockButton}>Copy</span></div>
      </div>
    </div>
  </figure>;
}
