import { Command } from "commander";
import { execSync, spawnSync, spawn as spawnAsync } from "child_process";
import { checkNodeVersion, checkAIRuntime, checkPorts } from "../lib/checks.js";
import { isInstalled, installBundled } from "../lib/install.js";
import { ensureSecrets } from "../lib/secrets.js";
import { runMigrations } from "../lib/migrate.js";
import { startServices, isRunning } from "../lib/services.js";
import {
  collectEmail,
  registerUser,
  createWorkspace,
  createMachineToken,
  activateToken,
  waitForServer,
} from "../lib/register.js";
import { DEFAULT_PORTS, WEB_URL, SELF_HOSTED_DIR } from "../lib/constants.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";

export function onboardCommand(): Command {
  return new Command("onboard")
    .description("Set up and start Alook locally")
    .option("--port-web <port>", "Web server port", String(DEFAULT_PORTS.web))
    .option("--port-email <port>", "Email worker port", String(DEFAULT_PORTS.emailWorker))
    .option("--port-ws <port>", "WebSocket worker port", String(DEFAULT_PORTS.wsDo))
    .option("--skip-register", "Skip account creation (just start services)")
    .action(async (opts) => {
      const ports = {
        web: parseInt(opts.portWeb, 10),
        emailWorker: parseInt(opts.portEmail, 10),
        wsDo: parseInt(opts.portWs, 10),
      };

      console.log("\n🚀 Alook Local Setup\n");

      // 1. Environment checks
      checkNodeVersion();

      // 2. Check ports
      await checkPorts(ports);

      // 3. Check AI runtimes
      console.log("Scanning for AI runtimes...");
      const runtimes = checkAIRuntime();
      if (runtimes.length === 0) {
        console.error("Error: no AI runtimes found.");
        console.error("Install one of: claude, codex, or opencode");
        process.exit(1);
      }
      console.log(`  Found: ${runtimes.map((r) => r.type).join(", ")}\n`);

      const devMode = !!process.env.ALOOK_PROJECT_ROOT;

      if (devMode) {
        // Dev mode: run predev + migrations from monorepo
        const root = process.env.ALOOK_PROJECT_ROOT!;
        console.log("Preparing dev environment...");
        try {
          execSync("pnpm predev", { cwd: root, stdio: "inherit" });
        } catch {}
        execSync("pnpm db:migrate", { cwd: root, stdio: "inherit" });
      } else {
        // Production: install bundled assets
        if (!isInstalled()) {
          console.log("Installing Alook...");
          installBundled();
        } else {
          console.log(`Installation found at ${SELF_HOSTED_DIR}`);
        }

        ensureSecrets(ports.web);
        patchWranglerConfigs(ports);
        runMigrations();
      }

      // 7. Collect user input before starting services
      let email: string | undefined;
      if (!opts.skipRegister) {
        email = await collectEmail();
      }

      // 8. Start services
      if (isRunning()) {
        console.log("\nServices already running.");
      } else {
        startServices(ports, { foreground: devMode });
      }

      // 9. Wait for web server
      const baseURL = WEB_URL(ports.web);
      console.log("\nWaiting for server to be ready...");
      await waitForServer(baseURL);
      console.log("  ✓ Server ready\n");

      // 10. Register with collected email
      if (email) {
        const { sessionCookie } = await registerUser(baseURL, email);
        const workspace = await createWorkspace(baseURL, sessionCookie);
        const { token } = await createMachineToken(baseURL, sessionCookie, workspace.id);
        const { runtimeIds } = await activateToken(baseURL, token, runtimes);

        console.log(`  ✓ Daemon registered with ${runtimes.map((r) => r.type).join(", ")} runtime`);
        console.log(`  ✓ Machine token activated\n`);

        // Start the daemon pointing to local server
        // Pass ALOOK_PROJECT_ROOT so CLI stores config in the same .alook/ dir
        const cliEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          ALOOK_SERVER_URL: baseURL,
        };
        if (process.env.ALOOK_PROJECT_ROOT) {
          cliEnv.ALOOK_PROJECT_ROOT = process.env.ALOOK_PROJECT_ROOT;
        }
        console.log("Starting daemon...");
        try {
          spawnSync("npx", ["@alook/cli", "register", "--token", token], {
            stdio: "inherit",
            env: cliEnv,
          });
          spawnSync("npx", ["@alook/cli", "daemon", "start"], {
            stdio: "inherit",
            env: cliEnv,
          });
        } catch {
          console.warn("  Warning: daemon auto-start failed. Start manually:");
          console.warn(`  ALOOK_SERVER_URL=${baseURL} npx @alook/cli register --token ${token}`);
          console.warn(`  ALOOK_SERVER_URL=${baseURL} npx @alook/cli daemon start`);
        }
      }

      // 11. Print summary
      console.log("\n" + "─".repeat(50));
      console.log("\n⚠️  Local mode: email send/receive is not available.");
      console.log("   To enable email, connect to alook.ai cloud.\n");
      console.log("─".repeat(50));
      console.log(`\n🎉 Alook is running!`);
      console.log(`   Dashboard: ${baseURL}`);
      console.log(`\n   Stop:   npx @alook/app stop`);
      console.log(`   Start:  npx @alook/app start`);
      console.log(`   Update: npx @alook/app update\n`);

      // 12. Open browser
      const openCmd = process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "cmd" : "xdg-open";
      try {
        const openArgs = process.platform === "win32"
          ? ["/c", "start", "", baseURL]
          : [baseURL];
        spawnAsync(openCmd, openArgs, { stdio: "ignore", detached: true }).unref();
      } catch {}
    });
}
