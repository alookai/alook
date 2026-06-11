import { hostname } from "os";
import { spawn } from "child_process";
import { openSync, closeSync, mkdirSync } from "fs";
import { dirname } from "path";
import { APIClient } from "./client.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "./config.js";
import { cmdPrefix, isDev } from "./env.js";
import { readDaemonPid, isProcessAlive } from "../daemon/pidfile.js";
import { daemonLogFilePath } from "../daemon/config.js";
import { startDaemon } from "../daemon/daemon.js";
import { resolveLoginShellEnv } from "./shell-env.js";
import { detectRuntimes } from "./runtimes.js";

interface ActivateResponse {
  daemon_id: string;
  workspace_id: string;
  runtimes: { id: string; provider: string }[];
}

interface Workspace {
  id: string;
  name: string;
}

interface AgentListItem {
  id: string;
}

export interface ActivateResult {
  workspaceId: string;
  workspaceName: string;
  runtimeProviders: string[];
}

export async function activateAndSave(opts: {
  token: string;
  serverUrl: string;
  profile?: string;
}): Promise<ActivateResult> {
  const { token, serverUrl, profile } = opts;

  console.log("Scanning for AI runtimes...");
  const runtimes = detectRuntimes();
  if (runtimes.length === 0) {
    console.error(
      "Error: no runtimes found. Install claude, codex, or opencode first.",
    );
    process.exit(1);
  }
  console.log(`Found: ${runtimes.map((r) => r.type).join(", ")}`);

  const host = hostname();
  console.log("Registering machine...");
  let activateResp: ActivateResponse;
  try {
    const res = await fetch(`${serverUrl}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, hostname: host, runtimes }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Error: registration failed (${res.status}): ${text}`);
      process.exit(1);
    }
    activateResp = await res.json() as ActivateResponse;
  } catch (err) {
    console.error(
      `Error: failed to activate: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const client = new APIClient(serverUrl, token);

  let workspaces: Workspace[];
  try {
    workspaces = await client.getJSON<Workspace[]>("/api/workspaces");
  } catch (err) {
    console.error(
      `Error: failed to fetch workspaces: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  if (!workspaces.length) {
    console.error("Error: no workspaces found for this user");
    process.exit(1);
  }

  const ws = workspaces.find((w) => w.id === activateResp.workspace_id) || workspaces[0];

  const wsClient = new APIClient(serverUrl, token, ws.id);
  let agentIds: string[] = [];
  try {
    const agents = await wsClient.getJSON<AgentListItem[]>(`/api/agents?workspace_id=${ws.id}`);
    agentIds = agents.map((a) => a.id);
  } catch {
    // Non-fatal
  }

  const existing = loadCLIConfigForProfile(profile);
  const watched = existing.watched_workspaces || [];
  const idx = watched.findIndex((w) => w.id === ws.id);
  if (idx >= 0) {
    watched[idx] = { id: ws.id, name: ws.name, token, status: "active", agent_ids: agentIds };
  } else {
    watched.push({ id: ws.id, name: ws.name, token, status: "active", agent_ids: agentIds });
  }

  saveCLIConfigForProfile(profile, {
    server_url: serverUrl,
    watched_workspaces: watched,
  });

  const daemonPid = readDaemonPid(profile);
  if (daemonPid && isProcessAlive(daemonPid)) {
    try {
      process.kill(daemonPid, "SIGHUP");
      console.log(`\nDaemon (pid ${daemonPid}) notified — workspace will be active shortly.`);
    } catch {
      console.log(`\nDaemon is running but could not be notified. Restart it to pick up the new workspace.`);
    }
  } else if (isDev() && process.stdout.isTTY) {
    console.log("\nStarting daemon in foreground...");
    await startDaemon(profile, serverUrl);
  } else {
    console.log("\nStarting daemon...");
    try {
      const entry = process.argv[1];
      const args = [entry];
      if (profile) args.push("--profile", profile);
      args.push("daemon", "start", "--foreground");

      const logPath = daemonLogFilePath();
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      const logFd = openSync(logPath, "a", 0o600);

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: resolveLoginShellEnv(),
      });
      child.unref();
      closeSync(logFd);
      console.log("Daemon started in background.");
      console.log(`Logs: ${logPath}`);
    } catch {
      console.log(`Failed to auto-start daemon. Run '${cmdPrefix()} daemon start' manually.`);
    }
  }

  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    runtimeProviders: activateResp.runtimes.map((r) => r.provider),
  };
}
