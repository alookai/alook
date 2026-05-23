import { Command } from "commander";
import { execSync, spawnSync, spawn as spawnAsync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
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
  waitForServer,
} from "../lib/register.js";
import { DEFAULT_PORTS, WEB_URL, SELF_HOSTED_DIR } from "../lib/constants.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";
import { buildCliEnv } from "../lib/cli-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

      // 4. Collect user input before heavy install/migrate work
      let email: string | undefined;
      if (!opts.skipRegister) {
        email = await collectEmail();
      }

      const devMode = !!process.env.ALOOK_PROJECT_ROOT;

      if (devMode) {
        // Dev mode: run predev + migrations from monorepo
        const root = process.env.ALOOK_PROJECT_ROOT!;
        console.log("Preparing dev environment...");
        try {
          execSync("pnpm predev", { cwd: root, stdio: "inherit" });
        } catch {}
        execSync("pnpm db:migrate", { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
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

        // Let CLI register handle token activation + config save
        const cliEntry = join(__dirname, "cli", "index.js");
        const cliEnv = buildCliEnv(ports.web);
        console.log("Starting daemon...");
        try {
          spawnSync("node", [cliEntry, "register", "--token", token], {
            stdio: "inherit",
            env: cliEnv,
          });
          spawnSync("node", [cliEntry, "daemon", "start"], {
            stdio: "inherit",
            env: cliEnv,
          });
        } catch {
          console.warn("  Warning: daemon auto-start failed. Start manually:");
          console.warn(`  npx @alook/app cli register --token ${token}`);
          console.warn(`  npx @alook/app cli daemon start`);
        }
      }

      // 11. Print summary
      console.log("\n" + "─".repeat(50));
      console.log("\n⚠️  Local mode: email send/receive is not available.");
      console.log("   To enable email, connect to alook.ai cloud.\n");
      console.log("─".repeat(50));
      console.log(`\n🎉 Alook is running!`);
      console.log(`   Dashboard: ${baseURL}`);
      if (email) {
        console.log(`   Login:     ${email}`);
      }
      console.log(`\n   Stop:   npx @alook/app stop`);
      console.log(`   Start:  npx @alook/app start`);
      console.log(`   Update: npx @alook/app update\n`);

      // 12. Copy email & open browser on Enter
      const signInURL = `${baseURL}/sign-in`;
      if (email) {
        try {
          execSync(`printf '%s' ${JSON.stringify(email)} | pbcopy`, { stdio: "ignore" });
          console.log(`   Email copied to clipboard.\n`);
        } catch {
          try {
            execSync(`printf '%s' ${JSON.stringify(email)} | xclip -selection clipboard`, { stdio: "ignore" });
            console.log(`   Email copied to clipboard.\n`);
          } catch {}
        }
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>((resolve) => {
        rl.question("Press Enter to open the dashboard...", () => {
          rl.close();
          resolve();
        });
      });

      const openCmd = process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "cmd" : "xdg-open";
      try {
        const openArgs = process.platform === "win32"
          ? ["/c", "start", "", signInURL]
          : [signInURL];
        spawnAsync(openCmd, openArgs, { stdio: "ignore", detached: true }).unref();
      } catch {}
    });
}
