import { Command } from "commander";
import { loadCLIConfigForProfile } from "./config.js";
import { cmdPrefix } from "./env.js";
import { getRootOpts } from "./command-utils.js";

export interface ResolvedClient {
  serverUrl: string;
  token: string;
  workspaceId: string;
}

export interface ResolvedClientPartial {
  serverUrl: string;
  token: string;
  workspaceId?: string;
}

export interface ResolveClientOptions {
  workspace?: string;
  agentId?: string;
}

export function resolveClientOpts(command: Command, opts: ResolveClientOptions = {}): ResolvedClient {
  const result = resolveClientOptsPartial(command, opts);
  if (!result.workspaceId) {
    console.error(
      "Error: cannot determine workspace. Set ALOOK_WORKSPACE_ID env var or use --workspace flag.",
    );
    process.exit(1);
  }
  return result as ResolvedClient;
}

export function resolveClientOptsPartial(command: Command, opts: ResolveClientOptions = {}): ResolvedClientPartial {
  const parentOpts = getRootOpts(command) as { server?: string; profile?: string };
  const cfg = loadCLIConfigForProfile(parentOpts.profile);

  // Server URL: flag > env > config
  const serverUrl = parentOpts.server || process.env.ALOOK_SERVER_URL || cfg.server_url;

  if (!serverUrl) {
    console.error("Error: no server URL configured. Set ALOOK_SERVER_URL or run register.");
    process.exit(1);
  }

  const workspaces = cfg.watched_workspaces || [];

  // Workspace resolution: flag > env > config lookup by agent_id > single workspace fallback
  let ws;
  const envWorkspaceId = process.env.ALOOK_WORKSPACE_ID;

  if (opts.workspace) {
    ws = workspaces.find((w) => w.id === opts.workspace);
    if (!ws) {
      if (envWorkspaceId === opts.workspace) {
        ws = undefined;
      } else {
        console.error(`Error: workspace ${opts.workspace} not found in config.`);
        process.exit(1);
      }
    }
  } else if (opts.agentId) {
    ws = workspaces.find((w) => w.agent_ids?.includes(opts.agentId!));
    if (!ws) {
      if (workspaces.length === 1) {
        ws = workspaces[0];
      }
    }
  } else if (workspaces.length === 1) {
    ws = workspaces[0];
  }

  // Token resolution: env > config > session_token
  const envToken = process.env.ALOOK_TOKEN;
  const token = envToken || ws?.token || cfg.session_token;

  if (!token) {
    console.error(
      `Error: not registered. Run '${cmdPrefix()} register --token <token>' first.`,
    );
    process.exit(1);
  }

  // Workspace ID resolution: ws from config > env > undefined (for partial)
  const workspaceId = ws?.id || envWorkspaceId || undefined;

  return { serverUrl, token, workspaceId };
}
