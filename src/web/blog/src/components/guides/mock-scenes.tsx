import { Bot, Check, ChevronDown, Circle, CircleDot, Dices, Laptop, Terminal } from "lucide-react";
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
    <figcaption>Example screen · use your own email</figcaption>
  </figure>;
}

export function ConnectDemo() {
  return <DeferredDemo scene="connect" label="Connect your computer">
    <div data-demo-frame>
      <div className={styles.mock}>
        <div className={styles.mockTitle}><Laptop size={20} />Connect a machine</div>
        <div className={styles.mockSub}>Run this on your machine</div>
        <div className={styles.inviteUrl}>{pairingCommand}</div>
        <div className={styles.mockFooter}><span className={styles.mockButton}>Copy</span></div>
      </div>
    </div>
    <div data-demo-frame>
      <div className={styles.terminal}>
        <div className={styles.terminalHeader}><Terminal size={14} />Terminal · your computer</div>
        <pre className={styles.command} data-command><span className={styles.prompt}>$ </span>{pairingCommand}</pre>
      </div>
    </div>
    <div data-demo-frame>
      <div className={styles.mock}>
        <div className={styles.mockTitle}>Machines</div>
        <div className={styles.botRow}><Laptop size={24} /><div><strong>Studio Mac</strong><small>Your connected computer</small></div><span className="ml-auto"><Online /></span></div>
      </div>
    </div>
  </DeferredDemo>;
}

function BotForm({ runtime, name }: { runtime: "codex" | "claude"; name: string }) {
  return <div className={styles.mock}>
    <div className={styles.mockTitle}>Create a bot</div>
    <div className={styles.botIdentity}><span className={styles.botIcon}><Bot size={20} /></span><div className={styles.botName}>{name}<Dices size={16} /></div><div className={styles.mockSub}>What is this bot for?</div></div>
    <div className={styles.formGroup}><span>Machine</span><div className={styles.radioOption} data-selected="true"><CircleDot size={14} />Studio Mac<span className="ml-auto"><Online /></span></div></div>
    <div className={styles.formGroup} data-runtime><span>Runtime</span>{(["codex", "claude"] as const).map((option) => <div key={option} className={styles.radioOption} data-selected={option === runtime}>
      {option === runtime ? <CircleDot size={14} /> : <Circle size={14} />}<ProviderLogo provider={option} className="size-4" />{option}
    </div>)}</div>
    <div className={styles.formGroup}><span>Model</span><div className={styles.modelOption}>Default ({runtime}&apos;s own default)<ChevronDown size={12} /></div></div>
    <div className={styles.formGroup}><span>Reasoning effort</span><div className={styles.modelOption}>Default<ChevronDown size={12} /></div></div>
    <div className={styles.mockFooter}><span>Cancel</span><span className={styles.mockButton}>Create bot</span></div>
  </div>;
}

export function BotsDemo() {
  return <DeferredDemo scene="bots" label="Create your two bots">
    <div data-demo-frame><BotForm runtime="codex" name="Milo" /></div>
    <div data-demo-frame><BotForm runtime="claude" name="Nova" /></div>
    <div data-demo-frame><div className={styles.mock}>
      <div className={styles.mockTitle}>My Bots</div>
      <div className={styles.mockSub}>Studio Mac</div>
      <BotRow name="Milo" detail="codex" /><BotRow name="Nova" detail="claude" />
    </div></div>
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
    <figcaption>Example invite · send your own link to each bot</figcaption>
  </figure>;
}
