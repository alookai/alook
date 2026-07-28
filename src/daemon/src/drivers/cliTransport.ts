/**
 * Shared CLI transport — the common launch scaffolding for every CLI-style
 * runtime (Claude, Codex, Gemini, Kimi, Copilot, Cursor, OpenCode, Antigravity).
 *
 * The runtime child process talks back to its host platform through a small
 * **Alook CLI**, reached purely via the exec environment (PATH + env vars). The
 * agent always invokes a stable `cliName`; a per-launch link in a PATH-prepended
 * bin dir points it at the host's real `hostCliPath` (POSIX symlink / Windows
 * `.cmd` shim — see `cliLink.ts`), so the host binary can be renamed/relocated
 * without touching the agent-facing surface, and no forwarding script is written
 * on POSIX.
 *
 * This module is deliberately host-agnostic: it ships an Alook-branded, swappable
 * CLI config (`alook` name + `ALOOK_*` env contract, no real `hostCliPath`). A
 * real deployment passes its own `CliTransportConfig` — the backend never
 * hardcodes any particular platform.
 *
 * `prepareCliTransport` builds the spawn environment from explicit layers (see
 * `spawnEnv.ts`) so override precedence is data, not spread order; the child can:
 *   - invoke the stable `cliName` (link → host `hostCliPath`) via PATH,
 *   - authenticate back to the host, and
 *   - see the neutral `<PREFIX>_*` runtime-context env vars.
 *
 * It also writes the assembled standing prompt as `AGENTS.md` (+ `CLAUDE.md`
 * symlink) into the agent's workdir — the ONE packing step every child-process
 * driver relies on, mirroring `src/cli/daemon/execenv/index.ts`'s
 * `writeInstructionFileIfChanged`, which does the same thing unconditionally
 * regardless of which runtime is about to be spawned. Every mainstream
 * coding-agent CLI this backend drives (Claude Code, Codex, Kimi, OpenCode,
 * Gemini, Cursor, Copilot, Antigravity) auto-reads `AGENTS.md`/`CLAUDE.md`
 * from cwd, so no driver needs its own bespoke delivery channel — there is
 * exactly one packing mechanism, not nine. (`pi` is the sole exception: it
 * runs in-process with no child process, so it doesn't go through
 * `prepareCliTransport` at all — it calls `writeAgentFile` directly with the
 * same file, for the same reason: its SDK auto-reads `AGENTS.md` from cwd.)
 *
 * AUTH IS ZERO-TRUST ONLY. The host must pass `ctx.credentialProxy` (a running
 * `CredentialBroker` + proxy URL); the transport mints a per-launch voucher and
 * injects `<PREFIX>_PROXY_URL` + `<PREFIX>_PROXY_TOKEN_FILE` as a sensitive layer.
 * The real key never enters the child's environment. There is no plaintext
 * fallback — without a credential proxy, `prepareCliTransport` throws. See
 * `src/credentials`.
 */
import * as fs from "fs";
import * as path from "path";
import type { LaunchContext, LaunchConfig } from "../types.js";
import { buildCliSystemPrompt } from "./systemPrompt.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { writeCliLink } from "./cliLink.js";
import { mergeEnvLayers, platformEnv, runtimeContextEnv, type EnvLayer } from "./spawnEnv.js";
import { buildGitIdentityEnv } from "./gitIdentityEnv.js";
import { writeAgentFile } from "./agentFile.js";

export interface PreparedCliTransport {
  /** Per-launch state directory created under the working directory. */
  stateDir: string;
  /**
   * Path to the credential file the child reads — the per-launch `vch_` voucher
   * (never the real key). The child sends it to the proxy, which swaps in the key.
   */
  tokenFile: string;
  spawnEnv: NodeJS.ProcessEnv;
}

/**
 * Host-supplied knobs for the CLI transport.
 *
 * The transport places a per-launch link named `cliName` in a `bin` dir and
 * prepends that dir to PATH. The agent always invokes the same stable name
 * (`cliName`, default `alook`); on POSIX the link is a symlink to `hostCliPath`,
 * on Windows a `.cmd` shim. This **decouples the agent-facing CLI name from the
 * host's real binary name** — the backend's prompts/contract never depend on what
 * the host actually calls its CLI, and the host can rename or relocate its binary
 * without touching the agent surface.
 */
export interface CliTransportConfig {
  /** Stable command name the agent invokes (the link's filename). */
  cliName: string;
  /** Prefix for injected env vars, e.g. "ALOOK" → ALOOK_ID, ALOOK_PROXY_TOKEN_FILE. */
  envPrefix: string;
  /** Name of the per-launch state directory under the working directory. */
  stateDirName: string;
  /**
   * Absolute path to the host's real agent CLI entrypoint the link points at.
   * Decoupled from `cliName`. On POSIX it MUST be a self-executable entrypoint
   * (shebang + executable bit — an npm `bin` symlink satisfies this); a host that
   * needs an interpreter prefix (`node script.js`) must ship its own self-exec
   * wrapper and pass that here. When omitted (the mock), no link is created and
   * `cliName` won't resolve.
   */
  hostCliPath?: string;
  /** Extra static env vars the host wants every runtime to see. */
  extraEnv?: Record<string, string>;
}

/**
 * The default Alook CLI config template. No `hostCliPath` is wired — a real
 * deployment overrides it with `{ ...DEFAULT_CLI_CONFIG, hostCliPath }`.
 */
export const DEFAULT_CLI_CONFIG: CliTransportConfig = {
  cliName: "alook",
  envPrefix: "ALOOK",
  stateDirName: ".alook",
};

function resolveStateHome(envPrefix: string): string {
  return (
    process.env[`${envPrefix}_HOME`] ||
    path.join(process.env.HOME || process.env.USERPROFILE || ".", `.${envPrefix.toLowerCase()}`)
  );
}

/**
 * Prepare the launch transport for a runtime child process.
 *
 * Creates a per-launch state dir + token file + a `bin/<cliName>` link (POSIX
 * symlink / Windows `.cmd` shim) prepended to PATH, so the agent always invokes
 * the stable `cliName` while the host's real `hostCliPath` stays decoupled behind
 * it. `spawnEnv` is assembled from explicit, precedence-ordered layers (see
 * `spawnEnv.ts`): base → host static → user env → driver → platform contract →
 * runtime context → network → provider-protected → credential (sensitive).
 *
 * @param ctx        launch context (agent id, working dir, config, …)
 * @param extraEnv   runtime-specific extra env (e.g. `{ NO_COLOR: "1" }`)
 * @param cli        CLI transport config (defaults to the Alook mock config)
 * @param platform   override for testing; defaults to process.platform
 */
export async function prepareCliTransport(
  ctx: LaunchContext,
  extraEnv: NodeJS.ProcessEnv = {},
  cli: CliTransportConfig = DEFAULT_CLI_CONFIG,
  platform: NodeJS.Platform = process.platform,
): Promise<PreparedCliTransport> {
  const E = cli.envPrefix;
  const stateHome = resolveStateHome(E);
  const stateDir = path.join(ctx.workingDirectory, cli.stateDirName);
  await fs.promises.mkdir(stateDir, { recursive: true });

  // Unified packing step for every child-process driver: write the standing
  // prompt as AGENTS.md (+ CLAUDE.md symlink) so any runtime that auto-reads
  // it from cwd picks it up, with no driver-specific plumbing required.
  if (ctx.standingPrompt) writeAgentFile(ctx.workingDirectory, ctx.standingPrompt);

  // Decouple the agent-facing `cliName` from the host binary via a filesystem
  // link in a PATH-prepended bin dir (symlink on POSIX, .cmd shim on Windows).
  const binDir = writeCliLink(stateDir, cli.cliName, cli.hostCliPath, platform);

  // Zero-trust credential handoff (no plaintext fallback). The broker mints a
  // per-launch voucher (writing the 0600 voucher file and keeping the real key);
  // the child gets only the proxy URL + voucher path (a sensitive layer below).
  if (!ctx.credentialProxy) {
    throw new Error(
      "prepareCliTransport: ctx.credentialProxy is required — start a credential proxy " +
      "(see src/credentials) and pass { broker, proxyUrl }. There is no plaintext mode.",
    );
  }
  const capabilities = ctx.credentialProxy.capabilities;
  // Guard: `capabilities` must be a real array. `undefined` is a caller wiring
  // bug (typically `{} as CredentialProxyHandoff` in a test) — surface it at
  // spawn time instead of crashing later inside `spawnEnv`'s `capabilities.join(",")`
  // with an opaque "Cannot read properties of undefined (reading 'join')". An
  // empty array IS allowed — that's a legitimate zero-capability launch.
  if (!Array.isArray(capabilities)) {
    throw new Error(
      "prepareCliTransport: credentialProxy.capabilities is required " +
      "(empty array is allowed for zero-capability launches; undefined is a wiring bug)",
    );
  }
  // The proxy uses `,` as the sole separator between capabilities on the wire
  // (`spawnEnv.ts` joins with "," and the proxy re-splits on ","). A capability
  // entry containing a comma would silently widen the enforced scope — reject
  // at wiring time so nobody smuggles in "send,attach" as a single token.
  for (const c of capabilities) {
    if (typeof c !== "string" || c.includes(",")) {
      throw new Error(
        `prepareCliTransport: capability entry ${JSON.stringify(c)} contains a comma ` +
        `(each capability must be a single token; use ["send","read"] instead of ["send,read"])`,
      );
    }
  }
  // Revoke this agent's previous voucher(s) before minting a new one — an
  // agent has at most one live launch at a time, so this bounds the broker's
  // registration map to "one live entry per active agent" regardless of how
  // many times it gets stopped and respawned. Without this, every respawn
  // leaves the old registration behind forever (nothing else in production
  // code ever calls revoke/revokeAgent) — an unbounded memory leak.
  ctx.credentialProxy.broker.revokeAgent(ctx.agentId);
  const reg = ctx.credentialProxy.broker.mint(
    ctx.agentId,
    ctx.launchId ?? "default",
    capabilities,
    ctx.credentialProxy.runnerKey,
  );
  const tokenFile = reg.voucherFile;

  const resolved = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
  const pathValue = [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

  // Explicit precedence-ordered layers (higher wins; sensitive applied last).
  const layers: EnvLayer[] = [
    { name: "hostStatic", precedence: 10, vars: cli.extraEnv ?? {} },
    { name: "userEnv", precedence: 20, vars: resolved.envVars },
    { name: "driver", precedence: 30, vars: extraEnv as Record<string, string | undefined> },
    // Per-agent git identity (GIT_AUTHOR_*/GIT_COMMITTER_*) so commits are
    // attributed to the agent that made them. ENV-ONLY by design — never writes
    // ~/.gitconfig or any repo .git/config, so the owner's own git identity is
    // untouched. Above `driver` (30) so a driver can't clobber it; below
    // `platformContract` (40) though keys don't overlap. Not sensitive.
    {
      name: "gitIdentity",
      precedence: 35,
      vars: buildGitIdentityEnv({
        agentName: ctx.config.agentName,
        discriminator: ctx.config.agentDiscriminator,
        agentId: ctx.agentId,
      }),
    },
    {
      name: "platformContract",
      precedence: 40,
      vars: {
        ...platformEnv(E, {
          stateHome,
          agentId: ctx.agentId,
          cliName: cli.cliName,
          serverUrl: ctx.config.serverUrl,
          capabilities,
          launchId: ctx.launchId,
          traceDir: ctx.cliTransportTraceDir,
        }),
        // Baseline color-off for every runtime CLI: ANSI escapes have no
        // meaning to the stream-json / JSON-RPC parsers on the other side and
        // routinely corrupt event boundaries. Every driver used to hand-set
        // NO_COLOR here — now it's a default all runtimes (including Claude)
        // inherit.
        //
        // A driver CANNOT opt out via its own `extraEnv`: that layer sits at
        // precedence 30, below this one (40), so a driver-supplied value is
        // overwritten here. If some future CLI genuinely misreads NO_COLOR,
        // opt it out by making these two keys conditional on a driver flag —
        // not by setting them in `extraEnv`, which silently does nothing.
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    },
    { name: "runtimeContext", precedence: 50, vars: runtimeContextEnv(E, ctx.config.runtimeContext) },
    {
      name: "network",
      precedence: 60,
      vars: { NO_PROXY: ["127.0.0.1", "localhost", process.env.NO_PROXY].filter(Boolean).join(","), PATH: pathValue },
    },
    // Provider-derived keys: protected so user/driver env can't accidentally
    // shadow them, but not secret enough to redact like the credential voucher.
    { name: "providerProtected", precedence: 70, vars: resolved.providerEnv },
    // Credential voucher path — sensitive: always wins, redacted in provenance.
    {
      name: "credential",
      precedence: 100,
      sensitive: true,
      vars: { [`${E}_PROXY_URL`]: ctx.credentialProxy.proxyUrl, [`${E}_PROXY_TOKEN_FILE`]: tokenFile },
    },
  ];

  const { env: spawnEnv } = mergeEnvLayers(process.env, layers);

  return { stateDir, tokenFile, spawnEnv };
}

/** Shared system-prompt entry point for CLI drivers. */
export function buildCliTransportSystemPrompt(config: LaunchConfig): string {
  return buildCliSystemPrompt(config);
}
