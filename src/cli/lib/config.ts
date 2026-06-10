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

export type { CLIConfig, ProfileConfig };

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
    if (!ws.status) ws.status = ws.id ? "active" : "deleted";
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
