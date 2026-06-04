import { hostname } from "os";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "./config.js";
import { cmdPrefix, isDev } from "./env.js";
import { readDaemonPid, isProcessAlive } from "../daemon/pidfile.js";
import { detectRuntimes } from "./runtimes.js";

interface ActivateResponse {
  daemon_id: string;
  token_status: string;
}

export interface ActivateResult {
  daemonId: string;
  tokenStatus: string;
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

  const existing = loadCLIConfigForProfile(profile);

  const watched = existing.watched_workspaces || [];
  if (!watched.some((w) => w.token === token)) {
    watched.push({ id: null, name: null, token, status: "registered", agent_ids: [] });
  }

  saveCLIConfigForProfile(profile, {
    server_url: serverUrl,
    watched_workspaces: watched,
  });

  const daemonPid = readDaemonPid(profile);
  if (daemonPid && isProcessAlive(daemonPid)) {
    try {
      process.kill(daemonPid, "SIGHUP");
      console.log(`\nDaemon (pid ${daemonPid}) notified — machine registered, awaiting workspace binding.`);
    } catch {
      console.log(`\nDaemon is running but could not be notified. Restart it to pick up the new token.`);
    }
  } else {
    const startCmd = isDev()
      ? `${cmdPrefix()} daemon start --foreground`
      : `${cmdPrefix()} daemon start`;
    console.log();
    console.log(`Run '${startCmd}' to start the daemon.`);
  }

  return {
    daemonId: activateResp.daemon_id,
    tokenStatus: activateResp.token_status,
  };
}
