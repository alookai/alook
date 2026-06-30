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
import { buildCliSystemPrompt, type SystemPromptOpts } from "./systemPrompt.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { writeCliLink } from "./cliLink.js";
import { mergeEnvLayers, platformEnv, runtimeContextEnv, type EnvLayer } from "./spawnEnv.js";

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
  /**
   * Capabilities granted to this launch (the host can scope them per agent).
   * Injected as `<PREFIX>_ACTIVE_CAPABILITIES` (comma-joined). Defaults to
   * `DEFAULT_ACTIVE_CAPABILITIES`.
   */
  activeCapabilities?: string[];
  /** Extra static env vars the host wants every runtime to see. */
  extraEnv?: Record<string, string>;
}

/** Default capability set when a host doesn't scope one. */
export const DEFAULT_ACTIVE_CAPABILITIES = [
  "send",
  "read",
  "mentions",
  "tasks",
  "reactions",
  "server",
  "channels",
  "knowledge",
];

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
  const capabilities = cli.activeCapabilities ?? DEFAULT_ACTIVE_CAPABILITIES;
  const stateDir = path.join(ctx.workingDirectory, cli.stateDirName);
  await fs.promises.mkdir(stateDir, { recursive: true });

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
        FORCE_COLOR: "0",
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
export function buildCliTransportSystemPrompt(config: LaunchConfig, opts: SystemPromptOpts): string {
  return buildCliSystemPrompt(config, opts);
}
