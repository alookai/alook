/**
 * Authentication is zero-trust. The host prepares the opaque credential-sensitive
 * layer; this transport merges it at the highest precedence. The real key must
 * not enter the child environment or require a credential-broker dependency.
 */
import * as fs from "fs";
import * as path from "path";
import type { AdapterLaunchContext } from "./adapter.js";
import { resolveLaunchFieldsOrDefault } from "./config.js";
import { writeCliLink, writeWindowsBashEnv } from "./cliLink.js";
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
      vars: {
        ...resource.platformProtected,
        ...(platform === "win32" && hostCliPath
          ? { [`${cli.envPrefix}_CLI`]: path.join(binDir, `${cli.cliName}.cmd`).replaceAll("\\", "/") }
          : {}),
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
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
  const spawnEnv = mergeEnvLayers(resource.base, layers);
  if (platform === "win32" && hostCliPath) {
    spawnEnv.BASH_ENV = writeWindowsBashEnv(binDir, cli.cliName, cli.envPrefix, spawnEnv.BASH_ENV);
  }
  const tokenFile = String(resource.credentialSensitive.ALOOK_PROXY_TOKEN_FILE ?? "");
  return { stateDir, tokenFile, spawnEnv };
}
