import { Command } from "commander";
import { fork, spawn } from "child_process";
import { fileURLToPath } from "url";
import { APIClient } from "../lib/client.js";
import { activateAndSave } from "../lib/activate.js";

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

async function pollAndActivate(opts: {
  deviceCode: string;
  interval: number;
  expiresIn: number;
  serverUrl: string;
  profile?: string;
}): Promise<void> {
  const { deviceCode, expiresIn, serverUrl, profile } = opts;
  let interval = opts.interval;
  const expiresAt = Date.now() + expiresIn * 1000;
  let tokenResp: TokenResponse | undefined;

  while (Date.now() < expiresAt) {
    await sleep(interval);

    try {
      const res = await fetch(`${serverUrl}/api/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
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
        console.error("Error: device code expired. Please run login again.");
        process.exit(1);
      } else if (errBody.error === "access_denied") {
        console.error("Error: authorization was denied.");
        process.exit(1);
      } else {
        console.error(`Error: unexpected error: ${errBody.error_description || errBody.error}`);
        process.exit(1);
      }
    } catch {
      console.error("Error: network request failed during polling.");
      process.exit(1);
    }
  }

  if (!tokenResp) {
    console.error("Error: device code expired (timed out). Please run login again.");
    process.exit(1);
  }

  const sessionToken = tokenResp.access_token;
  const client = new APIClient(serverUrl, sessionToken);

  let email = "";
  try {
    const me = await client.getJSON<{ id: string; email: string }>("/api/me");
    email = me.email;
  } catch {
    // Non-fatal — we can proceed without the email for display
  }

  // If user already has a workspace, pass it when creating machine token
  // so activate won't create a duplicate
  let existingWorkspaceId = "";
  try {
    const workspaces = await client.getJSON<{ id: string }[]>("/api/workspaces");
    if (workspaces.length > 0) {
      existingWorkspaceId = workspaces[0].id;
    }
  } catch {
    // Non-fatal — will create new workspace during activate
  }

  const mtUrl = existingWorkspaceId
    ? `/api/machine-tokens?workspace_id=${existingWorkspaceId}`
    : "/api/machine-tokens";

  let machineToken: string;
  try {
    const mtResp = await client.postJSON<{ token: string }>(mtUrl);
    machineToken = mtResp.token;
  } catch {
    process.exit(1);
  }

  const result = await activateAndSave({ token: machineToken, serverUrl, profile });

  if (email) {
    console.log(`\nLogged in as ${email}`);
  }
  console.log(`Workspace: ${result.workspaceName} (${result.workspaceId})`);
  console.log(`Runtimes: ${result.runtimeProviders.join(", ")}`);
}

// Background polling entry point — invoked as a detached child process in non-TTY mode
if (process.argv.includes("--__login-poll")) {
  const idx = process.argv.indexOf("--__login-poll");
  let data;
  try {
    data = JSON.parse(process.argv[idx + 1]);
  } catch {
    console.error("Error: invalid poll data");
    process.exit(1);
  }
  pollAndActivate(data).catch(() => process.exit(1));
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

      // Step 2: Display verification URL and code
      const verificationUrl = deviceResp.verification_uri_complete || deviceResp.verification_uri;
      console.log();
      console.log(`  Open this URL in your browser:`);
      console.log(`  ${verificationUrl}`);
      console.log();
      console.log(`  Enter code: ${deviceResp.user_code}`);
      console.log();

      // Non-TTY (AI agent context): fork a background poller and exit immediately
      // so the agent gets the URL output and can prompt the user to authorize.
      if (!process.stdout.isTTY) {
        const pollData = JSON.stringify({
          deviceCode: deviceResp.device_code,
          interval: (deviceResp.interval || 5) * 1000,
          expiresIn: deviceResp.expires_in,
          serverUrl,
          profile,
        });

        const thisFile = fileURLToPath(import.meta.url);
        const child = fork(thisFile, ["--__login-poll", pollData], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        console.log("  Polling for authorization in the background (timeout: 5min).");
        console.log("  Once approved, run `npx @alook/cli status` to verify.");
        return;
      }

      // TTY: open browser and poll in foreground
      openBrowser(verificationUrl);
      console.log("  (Browser opened automatically)");
      console.log();
      console.log("Waiting for authorization...");

      await pollAndActivate({
        deviceCode: deviceResp.device_code,
        interval: (deviceResp.interval || 5) * 1000,
        expiresIn: deviceResp.expires_in,
        serverUrl,
        profile,
      });
    });

  return cmd;
}
