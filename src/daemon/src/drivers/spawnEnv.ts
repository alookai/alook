/**
 * Layered spawn-env assembly.
 *
 * The child process environment is built from named layers, each declaring an
 * explicit `precedence` — higher wins. Precedence is DATA, not the order of a
 * spread expression, so the override rules are reviewable and unit-testable.
 *
 * A layer may be marked `sensitive` (credential material): such layers always
 * win regardless of declared precedence relative to non-sensitive layers, and
 * provenance dumps redact their values.
 *
 * See `docs/design-exec-env.md` for the layer table.
 */

export interface EnvLayer {
  /** Stable name for provenance/debug. */
  name: string;
  /** Higher overrides lower (among non-sensitive layers). */
  precedence: number;
  vars: Record<string, string | undefined>;
  /** Credential material: always wins, redacted in provenance. */
  sensitive?: boolean;
}

export interface MergedEnv {
  env: NodeJS.ProcessEnv;
  /** key → name of the layer that supplied the final value (for debug). */
  provenance: Record<string, string>;
}

/**
 * Merge `base` (e.g. process.env) with the given layers. Non-sensitive layers
 * apply in ascending precedence; sensitive layers apply last (so a misconfigured
 * lower layer can never shadow a voucher path or protected key). `undefined`
 * values are skipped (lets a layer "not set" a key without clobbering).
 */
export function mergeEnvLayers(base: NodeJS.ProcessEnv, layers: EnvLayer[]): MergedEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const provenance: Record<string, string> = {};

  const ordered = [
    ...layers.filter((l) => !l.sensitive).sort((a, b) => a.precedence - b.precedence),
    ...layers.filter((l) => l.sensitive).sort((a, b) => a.precedence - b.precedence),
  ];

  for (const layer of ordered) {
    for (const [k, v] of Object.entries(layer.vars)) {
      if (v === undefined) continue;
      env[k] = v;
      provenance[k] = layer.name;
    }
  }

  return { env, provenance };
}

/** Redact sensitive layers' values in a provenance dump (debug only). */
export function describeProvenance(layers: EnvLayer[], provenance: Record<string, string>): string {
  const sensitiveNames = new Set(layers.filter((l) => l.sensitive).map((l) => l.name));
  return Object.entries(provenance)
    .map(([k, layer]) => `${k} <- ${layer}${sensitiveNames.has(layer) ? " (redacted)" : ""}`)
    .sort()
    .join("\n");
}

/**
 * Typed builder for the platform `<PREFIX>_*` env contract. All keys live here,
 * so changing the prefix or adding a key is type-checked instead of relying on
 * scattered `${E}_XXX` string concatenation.
 */
export interface PlatformEnvFields {
  stateHome: string;
  agentId: string;
  cliName: string;
  serverUrl?: string;
  capabilities: string[];
  launchId?: string;
  traceDir?: string;
}

export function platformEnv(prefix: string, f: PlatformEnvFields): Record<string, string | undefined> {
  const E = prefix;
  return {
    [`${E}_HOME`]: f.stateHome,
    [`${E}_ID`]: f.agentId,
    [`${E}_CLI`]: f.cliName,
    [`${E}_SERVER_URL`]: f.serverUrl,
    [`${E}_ACTIVE_CAPABILITIES`]: f.capabilities.join(","),
    [`${E}_LAUNCH_ID`]: f.launchId,
    [`${E}_CLI_TRANSPORT_TRACE_DIR`]: f.traceDir,
  };
}

/** Build the `<PREFIX>_CURRENT_*` runtime-context env from a RuntimeContext. */
export function runtimeContextEnv(
  prefix: string,
  rc:
    | {
        agentId: string;
        serverId: string;
        computerId: string;
        computerName: string;
        hostname: string;
        os: string;
        daemonVersion: string;
        workspacePath: string;
      }
    | undefined,
): Record<string, string | undefined> {
  if (!rc) return {};
  const E = prefix;
  return {
    [`${E}_CURRENT_AGENT_ID`]: rc.agentId,
    [`${E}_CURRENT_SERVER_ID`]: rc.serverId,
    [`${E}_CURRENT_COMPUTER_ID`]: rc.computerId,
    [`${E}_CURRENT_COMPUTER_NAME`]: rc.computerName,
    [`${E}_CURRENT_COMPUTER_HOSTNAME`]: rc.hostname,
    [`${E}_CURRENT_COMPUTER_OS`]: rc.os,
    [`${E}_CURRENT_DAEMON_VERSION`]: rc.daemonVersion,
    [`${E}_CURRENT_WORKSPACE_PATH`]: rc.workspacePath,
  };
}
