import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface WatchedWorkspace {
  id: string | null;
  name: string | null;
  token: string;
  status?: "active" | "deleted";
  agent_ids?: string[];
}

type ActiveWorkspace = WatchedWorkspace & { id: string };

interface ProfileConfig {
  server_url: string;
  session_token?: string;
  watched_workspaces: WatchedWorkspace[];
}

interface CLIConfig {
  server_url?: string;
  session_token?: string;
  watched_workspaces?: WatchedWorkspace[];
  default_profile?: string;
  profiles?: Record<string, ProfileConfig>;
}

export type { CLIConfig, ProfileConfig, WatchedWorkspace, ActiveWorkspace };

/**
 * Effective status of a workspace entry. Soft-deleted entries linger in config
 * but are dead; legacy entries without an explicit status inherit the same rule
 * `loadCLIConfigForProfile` normalizes with (id ⇒ active, no id ⇒ deleted).
 */
function workspaceStatus(ws: WatchedWorkspace): "active" | "deleted" {
  return ws.status ?? (ws.id ? "active" : "deleted");
}

/**
 * The active workspaces are the only ones the daemon and CLI should ever act
 * on. All readers go through this so the "is this workspace live?" rule lives
 * in exactly one place — select the active entries, never scatter a
 * `status !== "deleted"` filter at each call site.
 */
export function activeWorkspaces(
  workspaces: WatchedWorkspace[] | undefined,
): ActiveWorkspace[] {
  return (workspaces || []).filter(
    (ws): ws is ActiveWorkspace => workspaceStatus(ws) === "active" && !!ws.id,
  );
}

/**
 * Mark a workspace live: upsert the entry, set `status="active"`, and refresh
 * name/token/agent_ids. Sole writer of the active transition — pairing,
 * re-login sync, and studio creation all funnel through here. Mutates `watched`
 * in place and returns it so the caller keeps ownership of load/save.
 */
export function markWorkspaceActive(
  watched: WatchedWorkspace[],
  fields: { id: string; name: string | null; token?: string; agent_ids?: string[] },
): WatchedWorkspace[] {
  const existing = watched.find((w) => w.id === fields.id);
  if (existing) {
    existing.status = "active";
    existing.name = fields.name;
    if (fields.token !== undefined) existing.token = fields.token;
    if (fields.agent_ids !== undefined) existing.agent_ids = fields.agent_ids;
  } else {
    watched.push({
      id: fields.id,
      name: fields.name,
      token: fields.token ?? "",
      status: "active",
      agent_ids: fields.agent_ids ?? [],
    });
  }
  return watched;
}

/**
 * Soft-delete a workspace by id: flip `status="deleted"` in place, leaving the
 * entry so the cause stays inspectable and re-pairing can revive it. Sole
 * writer of the deleted transition. No-op if the id is absent. Returns whether
 * an entry was found so the caller can decide to persist.
 */
export function markWorkspaceDeletedInList(
  watched: WatchedWorkspace[],
  workspaceId: string,
): boolean {
  const entry = watched.find((w) => w.id === workspaceId);
  if (!entry) return false;
  entry.status = "deleted";
  return true;
}

export function configDir(): string {
  return process.env.ALOOK_PROJECT_ROOT || join(homedir(), ".alook");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadCLIConfig(): CLIConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf-8"));
  } catch {
    return {};
  }
}

export function loadCLIConfigForProfile(profile?: string): ProfileConfig {
  const cfg = loadCLIConfig();
  const profileName = profile || cfg.default_profile;
  if (profileName && cfg.profiles?.[profileName]) {
    return cfg.profiles[profileName];
  }
  const result: ProfileConfig = {
    server_url: cfg.server_url || "",
    session_token: cfg.session_token,
    watched_workspaces: cfg.watched_workspaces || [],
  };

  // Default status for old entries without it
  for (const ws of result.watched_workspaces) {
    if (!ws.status) ws.status = workspaceStatus(ws);
  }

  return result;
}

export function saveCLIConfig(cfg: CLIConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function saveCLIConfigForProfile(
  profile: string | undefined,
  profileConfig: ProfileConfig,
): void {
  const cfg = loadCLIConfig();
  if (profile) {
    if (!cfg.profiles) cfg.profiles = {};
    cfg.profiles[profile] = profileConfig;
  } else {
    cfg.server_url = profileConfig.server_url;
    cfg.session_token = profileConfig.session_token;
    cfg.watched_workspaces = profileConfig.watched_workspaces;
    // Remove legacy machine_token if present
    delete (cfg as Record<string, unknown>).machine_token;
  }
  saveCLIConfig(cfg);
}
