/**
 * Core types for the agent-backend ("driver") layer.
 *
 * A *driver* adapts one AI coding runtime (Claude Code, Codex, Gemini, Kimi,
 * Pi, …) to a single uniform interface the daemon drives. The daemon never
 * speaks a runtime's native protocol directly — it goes through a driver, which
 * knows how to:
 *   - spawn / create the runtime session,
 *   - encode an outgoing user message onto the runtime's input channel,
 *   - normalize the runtime's stdout (or SDK event stream) into a small set of
 *     `ParsedEvent`s the daemon understands.
 *
 * This file is a clean-room reconstruction of the shapes observed in
 * a production agent-runtime daemon. Names and structure are reverse-engineered to
 * document the protocol, not copied from source.
 */

/* ------------------------------------------------------------------ */
/* Lifecycle & capability descriptors                                  */
/* ------------------------------------------------------------------ */

/**
 * How the runtime process maps onto "turns".
 *
 * - `persistent`: one long-lived process spans many turns. New user messages
 *   are written onto its still-open input channel (stdin / SDK call).
 * - `per_turn`: the process handles exactly one turn and exits. A new message
 *   means a brand-new process.
 */
export type DriverLifecycle =
  | {
    kind: "persistent";
    /**
     * How busy-time stdin writes are timed:
     * - `direct`: write immediately (runtime tolerates injection any time).
     * - `gated`: hold writes until a safe stream boundary (Claude — avoids
     *   colliding with in-flight signed thinking blocks).
     */
    stdin: "direct" | "gated";
    /** What to do if a message arrives while a turn is in flight. */
    inFlightWake: "steer" | "queue";
  }
  | {
    kind: "per_turn";
    /**
     * When to spawn:
     * - `immediate`: spawn as soon as woken.
     * - `defer_until_concrete_message`: don't spawn for bookkeeping-only
     *   wakes (e.g. a system task event); wait for a real message.
     */
    start: "immediate" | "defer_until_concrete_message";
    /** How the per-turn process ends. */
    exit: "natural" | "terminate_on_turn_end";
    /** A wake mid-turn either starts a new process or folds into the pending run. */
    inFlightWake: "spawn_new" | "coalesce_into_pending";
  };

/** Session recovery strategy across restarts. */
export interface DriverSession {
  /** `resume_or_fresh`: resume by sessionId if we have one, else start fresh. */
  recovery: "resume_or_fresh";
}

/**
 * How a model id is turned into launch configuration. CLI drivers emit `args`;
 * in-process SDK drivers emit `params`.
 */
export interface DriverModel {
  /**
   * - `launchable`: detected models are real and can be launched as-is.
   * - `suggestion_only`: detected models are hints; not passed at launch.
   */
  detectedModelsVerifiedAs: "launchable" | "suggestion_only";
  toLaunchSpec: (
    modelId: string,
    ctx?: LaunchContext,
    opts?: unknown,
  ) => { args: string[] } | { params: Record<string, unknown> };
}

/**
 * Busy-delivery mode — how a message is delivered while the agent is working.
 * - `direct`: write straight to the input channel.
 * - `gated`: queue until a safe boundary (see `ApmGatedSteering`).
 * - `none`: not supported (per-turn runtimes); the agent polls instead.
 */
export type BusyDeliveryMode = "direct" | "gated" | "none";

/* ------------------------------------------------------------------ */
/* Normalized runtime events                                           */
/* ------------------------------------------------------------------ */

/**
 * The uniform event vocabulary every driver's `parseLine` (or SDK mapper)
 * collapses its native protocol into. The daemon only ever sees these.
 */
export type ParsedEvent =
  | { kind: "session_init"; sessionId: string }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_output"; name: string }
  | { kind: "compaction_started" }
  | { kind: "compaction_finished" }
  | { kind: "review_started" }
  | { kind: "review_finished" }
  | { kind: "internal_progress"; source?: string; itemType?: string; payloadBytes?: number }
  | { kind: "runtime_diagnostic"; severity?: string; source?: string; message: string }
  | { kind: "turn_end"; sessionId?: string }
  | { kind: "error"; message: string }
  | {
    kind: "telemetry";
    name: "token_usage" | "rate_limits";
    source: string;
    usageKind?: string;
    attrs: Record<string, unknown>;
  };

/* ------------------------------------------------------------------ */
/* Launch context & stdin encoding                                     */
/* ------------------------------------------------------------------ */

/** Everything a driver needs to launch (or create) a runtime session. */
export interface LaunchContext {
  agentId: string;
  launchId?: string;
  workingDirectory: string;
  /** The fully-assembled system / standing prompt for this agent. */
  standingPrompt: string;
  /** The first user message to deliver (initial turn text). */
  prompt: string;
  /** Path to the injected Alook CLI wrapper (host-supplied; see cliTransport). */
  agentCliPath?: string;
  daemonApiKey?: string;
  cliTransportTraceDir?: string;
  /**
   * Zero-trust credential handoff (REQUIRED to spawn a CLI runtime). The host
   * starts one `startCredentialProxy` and passes its `broker` + `proxyUrl` here;
   * `cliTransport` mints a per-launch `vch_` voucher and the agent never sees the
   * real key. There is no plaintext fallback — see `src/credentials`.
   */
  credentialProxy?: CredentialProxyHandoff;
  config: LaunchConfig;
}

/** What the host passes so `cliTransport` can mint a voucher for the child. */
export interface CredentialProxyHandoff {
  /** Mints/validates the per-launch voucher (bound to the agent's runner key). */
  broker: import("./credentials").CredentialBroker;
  /** URL of the already-running proxy (from `startCredentialProxy`). */
  proxyUrl: string;
  /**
   * The agent's tier-2 runner key the proxy swaps in for this launch's voucher.
   * The daemon obtains it from the server's enrollment (`mintAgentCredential`,
   * authed by the machine key) before spawning the agent.
   */
  runnerKey: string;
}

export interface LaunchConfig {
  /** Resume target. Absent ⇒ fresh session. */
  sessionId?: string;
  authToken?: string;
  serverUrl?: string;
  /**
   * The structured, versioned runtime configuration (model / provider / mode /
   * reasoningEffort / command). Drivers call `resolveLaunchFields(runtimeConfig)`
   * to turn it into CLI args + env — see `src/runtimeConfig.ts`. Optional only so
   * minimal test contexts can omit it (drivers then use the runtime's default
   * model with no provider/mode overrides).
   */
  runtimeConfig?: import("./runtimeConfig").RuntimeConfig;
  description?: string;
  runtimeContext?: RuntimeContext;
  /** Agent display name (e.g. "Cindy"). */
  agentName?: string;
  /**
   * Agent's global @mention handle, `@name#0042` (e.g. "@cindy#4821"). Every
   * account in Alook — human or agent — has a name plus a 4-digit
   * discriminator; this is the `@`-prefixed pair, unique even when names
   * collide.
   */
  agentHandle?: string;
}

export interface RuntimeContext {
  agentId: string;
  serverId: string;
  computerId: string;
  computerName: string;
  hostname: string;
  os: string;
  daemonVersion: string;
  workspacePath: string;
}

/** Mode for an outgoing message written onto the input channel. */
export type StdinMode = "busy" | "idle";

export interface EncodeOpts {
  mode?: StdinMode;
}

/* ------------------------------------------------------------------ */
/* The Driver interface                                                */
/* ------------------------------------------------------------------ */

export interface SpawnResult {
  process: import("child_process").ChildProcess;
}

/**
 * What an in-process SDK driver's `createSession` needs injected, so the
 * driver file itself stays dependency-free (no hard dep on the vendor SDK
 * package) — the host builds the real implementations per-launch (they close
 * over the `LaunchContext`) and passes them in. See
 * `drivers/piSdkDeps.ts::createPiSdkDriverDeps` for the only real
 * implementation today.
 */
export interface SdkDriverDeps {
  /** Build the per-launch spawn env (credential voucher, PATH link, …). */
  buildSpawnEnv: () => Promise<NodeJS.ProcessEnv>;
  /** Create the vendor SDK's session object. Shape is driver-specific. */
  createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: unknown; sessionId: string }>;
}

/**
 * The contract every runtime adapter implements. Child-process drivers
 * implement `spawn`; in-process SDK drivers implement `createSession` instead
 * (and throw from `spawn`).
 */
export interface Driver {
  readonly id: string;
  readonly lifecycle: DriverLifecycle;
  readonly session: DriverSession;
  readonly model: DriverModel;

  /** True if the runtime accepts mid-session input (steering / idle prompts). */
  readonly supportsStdinNotification: boolean;
  readonly busyDeliveryMode: BusyDeliveryMode;
  /** True if the runtime takes the standing prompt natively (vs. inline). */
  readonly supportsNativeStandingPrompt?: boolean;

  /** Per-turn runtimes only: terminate the process when the turn ends. */
  readonly terminateProcessOnTurnEnd?: boolean;
  /** Persistent runtimes only: close stdin (rather than keep-alive) on turn end. */
  readonly endStdinOnTurnEnd?: boolean;
  /** Per-turn runtimes only: skip spawning for bookkeeping-only wakes. */
  readonly deferSpawnUntilMessage?: boolean;

  /** Detect whether the runtime CLI is installed and its version. */
  probe(): ProbeResult | Promise<ProbeResult>;

  /** Spawn the child process (child-process drivers). */
  spawn(ctx: LaunchContext): Promise<SpawnResult>;

  /**
   * Create the runtime session for in-process SDK drivers (Pi). Builds and
   * wires the session but does NOT fire the initial prompt — the caller
   * (`SdkManagedSession.start`) attaches its own `"runtime_event"` listener
   * to the returned session first, then sends the first turn, so no early
   * events are lost. Absent on child-process drivers.
   */
  createSession?(ctx: LaunchContext, deps: SdkDriverDeps): Promise<import("./runtime/sdkRuntimeSession.js").SdkRuntimeSession>;

  /** Parse one stdout line into zero or more normalized events. */
  parseLine(line: string): ParsedEvent[];

  /** The active session id, learned from the runtime's init/result events. */
  readonly currentSessionId: string | null;

  /**
   * Encode an outgoing user message for the input channel.
   * Returns the wire string (a `\n` is appended by the caller), or `null` if
   * this runtime cannot accept mid-session input.
   */
  encodeStdinMessage(text: string, sessionId: string | null, opts?: EncodeOpts): string | null;

  /** Build the standing/system prompt for this runtime. */
  buildSystemPrompt(config: LaunchConfig, agentId?: string): string;
}

export interface ProbeResult {
  /** Explicit health signal reported by the daemon. */
  status: "healthy" | "unhealthy";
  version?: string;
  /** Short reason code when unhealthy — e.g. "version_probe_failed". */
  lastError?: string;
}
