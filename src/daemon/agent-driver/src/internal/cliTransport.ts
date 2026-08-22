/**
 * Shared CLI transport — the common launch scaffolding for every CLI-style
 * runtime (Claude, Codex, Cursor, OpenCode).
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
 * AUTH IS ZERO-TRUST ONLY. The host prepares the credential-sensitive
 * environment layer before the adapter runs; this transport only merges that
 * opaque layer at the highest precedence. The real key never enters the
 * child's environment and the package has no credential-broker dependency.
 */
import * as fs from "fs";
import * as path from "path";
import type { AdapterLaunchContext } from "./adapter.js";
import { resolveLaunchFieldsOrDefault } from "./config.js";
import { writeCliLink } from "./cliLink.js";
import { mergeEnvLayers, type EnvLayer } from "./spawnEnv.js";

interface PreparedCliTransport {
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
const DEFAULT_CLI_CONFIG: CliTransportConfig = {
  cliName: "alook",
  envPrefix: "ALOOK",
  stateDirName: ".alook",
};

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
  ctx: AdapterLaunchContext,
  extraEnv: NodeJS.ProcessEnv = {},
  cli: CliTransportConfig = DEFAULT_CLI_CONFIG,
  platform: NodeJS.Platform = process.platform,
): Promise<PreparedCliTransport> {
  const stateDir = path.join(ctx.workingDirectory, cli.stateDirName);
  await fs.promises.mkdir(stateDir, { recursive: true });
  const hostCliPath = cli.hostCliPath ?? ctx.prepared.executablePath;
  const binDir = writeCliLink(stateDir, cli.cliName, hostCliPath, platform);
  const resolved = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
  const resource = ctx.prepared.environmentLayers;
  const pathValue = [
    binDir,
    resource.networkProtected.PATH,
    resource.base.PATH,
  ].filter(Boolean).join(path.delimiter);
  const layers: EnvLayer[] = [
    {
      name: "hostStatic",
      precedence: 10,
      vars: { ...resource.hostStatic, ...(cli.extraEnv ?? {}) },
    },
    { name: "userEnv", precedence: 20, vars: resolved.envVars },
    { name: "driver", precedence: 30, vars: extraEnv as Record<string, string | undefined> },
    { name: "identityProtected", precedence: 35, vars: resource.identityProtected },
    {
      name: "platformProtected",
      precedence: 40,
      vars: { ...resource.platformProtected, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
    { name: "runtimeProtected", precedence: 50, vars: resource.runtimeProtected },
    {
      name: "networkProtected",
      precedence: 60,
      vars: { ...resource.networkProtected, PATH: pathValue },
    },
    { name: "providerProtected", precedence: 70, vars: resolved.providerEnv },
    {
      name: "credentialSensitive",
      precedence: 100,
      sensitive: true,
      vars: resource.credentialSensitive,
    },
  ];
  const { env: spawnEnv } = mergeEnvLayers(resource.base, layers);
  const tokenFile = String(resource.credentialSensitive.ALOOK_PROXY_TOKEN_FILE ?? "");
  return { stateDir, tokenFile, spawnEnv };
}
