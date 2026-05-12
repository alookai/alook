import { Command } from "commander";
import { execSync } from "child_process";
import { hostname } from "os";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { cmdPrefix, isDev } from "../lib/env.js";
import { readDaemonPid, isProcessAlive } from "../daemon/pidfile.js";

interface MeResponse {
  id: string;
  email: string;
}

interface Workspace {
  id: string;
  name: string;
}

interface AgentListItem {
  id: string;
}

interface ActivateResponse {
  daemon_id: string;
  workspace_id: string;
  runtimes: { id: string; provider: string }[];
}

function isCommandAvailable(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectRuntimes(): { type: string; version: string }[] {
  const found: { type: string; version: string }[] = [];
  for (const type of ["claude", "codex", "opencode"]) {
    if (isCommandAvailable(type)) {
      let version = "";
      try {
        version = execSync(`${type} --version`, { encoding: "utf-8" }).trim();
      } catch {
        // version detection optional
      }
      found.push({ type, version });
    }
  }
  return found;
}

export function registerCommand(): Command {
  const cmd = new Command("register")
    .description("Register CLI with your Alook account")
    .requiredOption("--token <token>", "API token (starts with al_)")
    .option("--server <url>", "Server URL")
    .option("--profile <name>", "Profile name")
    .action(async (opts, command) => {
      const token: string = opts.token;
      const profile: string | undefined =
        opts.profile || command.parent?.opts().profile;
      const serverUrl: string =
        opts.server ||
        command.parent?.opts().server ||
        process.env.ALOOK_SERVER_URL ||
        "https://alook.ai";

      if (!token) {
        console.error(
          `Error: --token is required\nUsage: ${cmdPrefix()} register --token <token>`,
        );
        process.exit(1);
      }

      if (!token.startsWith("al_")) {
        console.error(
          "Error: invalid token format: must start with 'al_'",
        );
        process.exit(1);
      }

      const client = new APIClient(serverUrl, token);

      // Verify token
      let me: MeResponse;
      try {
        me = await client.getJSON<MeResponse>("/api/me");
      } catch (err) {
        console.error(
          `Error: failed to verify token: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      // Detect local runtimes
      console.log("Scanning for AI runtimes...");
      const runtimes = detectRuntimes();
      if (runtimes.length === 0) {
        console.error(
          "Error: no runtimes found. Install claude, codex, or opencode first.",
        );
        process.exit(1);
      }
      console.log(
        `Found: ${runtimes.map((r) => r.type).join(", ")}`,
      );

      // Activate token — may create workspace if none exists
      const host = hostname();
      console.log("Registering runtime...");
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

      // Fetch workspaces after activation (activation may have created one)
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

      // Use the workspace_id from activate response to find the correct workspace
      const ws = workspaces.find((w) => w.id === activateResp.workspace_id) || workspaces[0];

      // Fetch agents for this workspace
      const wsClient = new APIClient(serverUrl, token, ws.id);
      let agentIds: string[] = [];
      try {
        const agents = await wsClient.getJSON<AgentListItem[]>(`/api/agents?workspace_id=${ws.id}`);
        agentIds = agents.map((a) => a.id);
      } catch {
        // Non-fatal — agent_ids will be empty
      }

      // Load existing config to preserve other workspaces
      const existing = loadCLIConfigForProfile(profile);
      const watched = existing.watched_workspaces || [];
      const idx = watched.findIndex((w) => w.id === ws.id);
      if (idx >= 0) {
        watched[idx] = { id: ws.id, name: ws.name, token, agent_ids: agentIds };
      } else {
        watched.push({ id: ws.id, name: ws.name, token, agent_ids: agentIds });
      }

      saveCLIConfigForProfile(profile, {
        server_url: serverUrl,
        watched_workspaces: watched,
      });

      console.log(`\nRegistered as ${me.email}`);
      console.log(`Workspace: ${ws.name} (${ws.id})`);
      console.log(`Runtimes: ${activateResp.runtimes.map((r) => r.provider).join(", ")}`);

      // Notify running daemon to pick up the new workspace
      const daemonPid = readDaemonPid(profile);
      if (daemonPid && isProcessAlive(daemonPid)) {
        try {
          process.kill(daemonPid, "SIGHUP");
          console.log(`\nDaemon (pid ${daemonPid}) notified — workspace will be active shortly.`);
        } catch {
          console.log(`\nDaemon is running but could not be notified. Restart it to pick up the new workspace.`);
        }
      } else {
        const startCmd = isDev()
          ? `${cmdPrefix()} daemon start --foreground`
          : `${cmdPrefix()} daemon start`;
        console.log();
        console.log(`Run '${startCmd}' to start the daemon.`);
      }
    });

  return cmd;
}
