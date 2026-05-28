import { Command } from "commander";
import { spawn } from "child_process";
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

interface MeResponse {
  id: string;
  email: string;
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

      // Step 5: Activate and save config
      const result = await activateAndSave({ token: machineToken, serverUrl, profile });

      console.log(`\nLogged in as ${me.email}`);
      console.log(`Workspace: ${result.workspaceName} (${result.workspaceId})`);
      console.log(`Runtimes: ${result.runtimeProviders.join(", ")}`);
    });

  return cmd;
}
