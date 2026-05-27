import { Command } from "commander";
import { execSync, spawn } from "child_process";
import { hostname } from "os";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { cmdPrefix, isDev } from "../lib/env.js";
import { readDaemonPid, isProcessAlive } from "../daemon/pidfile.js";

const DEVICE_CLIENT_ID = process.env.ALOOK_DEVICE_CLIENT_ID || "alook-cli";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

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

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" :
      process.platform === "linux" ? "xdg-open" :
      process.platform === "win32" ? "start" : null;
    if (cmd) {
      const args = process.platform === "win32" ? ["", url] : [url];
      spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Browser open is best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loginCommand(): Command {
  const cmd = new Command("login")
    .description("Log in to Alook via browser (device code flow)")
    .option("--server <url>", "Server URL")
    .option("--profile <name>", "Profile name")
    .action(async (opts, command) => {
      const profile: string | undefined =
        opts.profile || command.parent?.opts().profile;
      const serverUrl: string =
        opts.server ||
        command.parent?.opts().server ||
        process.env.ALOOK_SERVER_URL ||
        "https://alook.ai";

      // Step 1: Request device code
      console.log("Requesting device code...");
      let deviceResp: DeviceCodeResponse;
      try {
        const res = await fetch(`${serverUrl}/api/auth/device/code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error: failed to get device code (${res.status}): ${text}`);
          process.exit(1);
        }
        deviceResp = await res.json() as DeviceCodeResponse;
      } catch (err) {
        console.error(
          `Error: failed to request device code: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      // Step 2: Display code and open browser
      const verificationUrl = deviceResp.verification_uri_complete || deviceResp.verification_uri;
      console.log();
      console.log(`  Open this URL in your browser:`);
      console.log(`  ${verificationUrl}`);
      console.log();
      console.log(`  Enter code: ${deviceResp.user_code}`);
      console.log();

      if (process.stdout.isTTY) {
        openBrowser(verificationUrl);
        console.log("  (Browser opened automatically)");
        console.log();
      }

      // Step 3: Poll for token
      console.log("Waiting for authorization...");
      let interval = (deviceResp.interval || 5) * 1000;
      const expiresAt = Date.now() + deviceResp.expires_in * 1000;
      let tokenResp: TokenResponse | undefined;

      while (Date.now() < expiresAt) {
        await sleep(interval);

        try {
          const res = await fetch(`${serverUrl}/api/auth/device/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: deviceResp.device_code,
              client_id: DEVICE_CLIENT_ID,
            }),
          });

          if (res.ok) {
            tokenResp = await res.json() as TokenResponse;
            break;
          }

          const errBody = await res.json() as TokenErrorResponse;
          if (errBody.error === "slow_down") {
            interval += 5000;
          } else if (errBody.error === "authorization_pending") {
            // Keep polling
          } else if (errBody.error === "expired_token") {
            console.error("Error: device code expired. Please try again.");
            process.exit(1);
          } else if (errBody.error === "access_denied") {
            console.error("Error: authorization was denied.");
            process.exit(1);
          } else {
            console.error(`Error: ${errBody.error_description || errBody.error}`);
            process.exit(1);
          }
        } catch (err) {
          console.error(
            `Error polling for token: ${err instanceof Error ? err.message : err}`,
          );
          process.exit(1);
        }
      }

      if (!tokenResp) {
        console.error("Error: device code expired. Please try again.");
        process.exit(1);
      }

      console.log("Authorization received!");

      // Step 4: Use session token to create machine token
      const sessionToken = tokenResp.access_token;
      const client = new APIClient(serverUrl, sessionToken);

      let me: MeResponse;
      try {
        me = await client.getJSON<MeResponse>("/api/me");
      } catch (err) {
        console.error(
          `Error: failed to verify session: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      // Create machine token
      let machineToken: string;
      try {
        const mtResp = await client.postJSON<{ token: string }>("/api/machine-tokens");
        machineToken = mtResp.token;
      } catch (err) {
        console.error(
          `Error: failed to create machine token: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      // Step 5: Activate (reuse register.ts logic)
      const mtClient = new APIClient(serverUrl, machineToken);

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
      console.log("Registering runtime...");
      let activateResp: ActivateResponse;
      try {
        const res = await fetch(`${serverUrl}/api/machine-tokens/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: machineToken, hostname: host, runtimes }),
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

      // Fetch workspaces
      let workspaces: Workspace[];
      try {
        workspaces = await mtClient.getJSON<Workspace[]>("/api/workspaces");
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

      // Fetch agents
      const wsClient = new APIClient(serverUrl, machineToken, ws.id);
      let agentIds: string[] = [];
      try {
        const agents = await wsClient.getJSON<AgentListItem[]>(`/api/agents?workspace_id=${ws.id}`);
        agentIds = agents.map((a) => a.id);
      } catch {
        // Non-fatal
      }

      // Step 6: Save config
      const existing = loadCLIConfigForProfile(profile);
      const watched = existing.watched_workspaces || [];
      const idx = watched.findIndex((w) => w.id === ws.id);
      if (idx >= 0) {
        watched[idx] = { id: ws.id, name: ws.name, token: machineToken, agent_ids: agentIds };
      } else {
        watched.push({ id: ws.id, name: ws.name, token: machineToken, agent_ids: agentIds });
      }

      saveCLIConfigForProfile(profile, {
        server_url: serverUrl,
        watched_workspaces: watched,
      });

      console.log(`\nLogged in as ${me.email}`);
      console.log(`Workspace: ${ws.name} (${ws.id})`);
      console.log(`Runtimes: ${activateResp.runtimes.map((r) => r.provider).join(", ")}`);

      // Notify daemon
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
