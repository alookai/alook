import { Command } from "commander";
import { execSync, spawn as spawnAsync } from "node:child_process";
import { createInterface } from "node:readline";
import { checkNodeVersion, checkPorts, validateServicePortProfile } from "../lib/checks.js";
import {
  assertInstallationComplete,
  getMissingInstallFiles,
  installBundled,
  isInstalled,
} from "../lib/install.js";
import { ensureSecrets } from "../lib/secrets.js";
import { runMigrations } from "../lib/migrate.js";
import { inspectServices, startServices } from "../lib/services.js";
import { collectEmail, registerUser, createPairingToken } from "../lib/register.js";
import {
  installOwnedSignalCleanup,
  waitForExistingServices,
  waitForOwnedServices,
  type OwnedSignalCleanup,
} from "../lib/startup.js";
import { clearRegistry } from "../lib/pid.js";
import { acquireLifecycleReservation, releaseLifecycleReservation } from "../lib/lifecycle-lock.js";
import {
  createServicePortProfile,
  DEFAULT_PORTS,
  WEB_URL,
  SELF_HOSTED_DIR,
} from "../lib/constants.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";
import { pairAndStartDaemon } from "../lib/daemon.js";

export function onboardCommand(): Command {
  return new Command("onboard")
    .description("Set up and start Alook locally")
    .option("--port-web <port>", "Web server port", String(DEFAULT_PORTS.web))
    .option("--port-email <port>", "Email worker port", String(DEFAULT_PORTS.emailWorker))
    .option("--port-ws <port>", "WebSocket worker port", String(DEFAULT_PORTS.wsDo))
    .option("--port-wake <port>", "Wake worker port", String(DEFAULT_PORTS.wakeWorker))
    .option("--skip-register", "Skip account creation (just start services)")
    .option("--no-open", "Do not prompt, copy to clipboard, or open a browser")
    .action(async (opts) => {
      const ports = {
        web: parseInt(opts.portWeb, 10),
        emailWorker: parseInt(opts.portEmail, 10),
        wsDo: parseInt(opts.portWs, 10),
        wakeWorker: parseInt(opts.portWake, 10),
      };
      const profile = createServicePortProfile(ports);
      validateServicePortProfile(profile);

      console.log("\n🚀 Alook Local Setup\n");
      checkNodeVersion();

      let email: string | undefined;
      if (!opts.skipRegister) email = await collectEmail();

      const devMode = !!process.env.ALOOK_PROJECT_ROOT;
      const reservation = await acquireLifecycleReservation();
      let ownedHandle: Awaited<ReturnType<typeof startServices>> | undefined;
      let signalCleanup: OwnedSignalCleanup | undefined;
      let servicesReady = false;
      try {
        const inspection = await inspectServices(profile);
        if (inspection.state === "reusable") {
          console.log("\nServices already running; revalidating all four health endpoints...");
          await waitForExistingServices(inspection.registry);
        } else if (inspection.state === "none" || inspection.state === "stale") {
          if (inspection.state === "stale") clearRegistry(inspection.registry.runId);
          await checkPorts(profile);

          if (devMode) {
            const root = process.env.ALOOK_PROJECT_ROOT!;
            console.log("Preparing dev environment...");
            try {
              execSync("pnpm predev", { cwd: root, stdio: "inherit" });
            } catch {}
            execSync("pnpm db:migrate", { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
          } else {
            if (!isInstalled()) {
              const missingFiles = getMissingInstallFiles();
              console.log(`Installing missing Alook files (${missingFiles.length} required files missing)...`);
              installBundled();
            } else {
              console.log(`Installation found at ${SELF_HOSTED_DIR}`);
            }
            assertInstallationComplete();
            ensureSecrets(profile.web.business);
            patchWranglerConfigs(profile);
            runMigrations();
          }

          ownedHandle = await startServices(profile, {
            foreground: devMode,
            onHandle: (handle) => {
              signalCleanup = installOwnedSignalCleanup(handle, reservation);
            },
          });
          console.log("\nWaiting for all services to be ready...");
          await waitForOwnedServices(ownedHandle);
          servicesReady = true;
        } else {
          throw new Error(`${inspection.state}: ${inspection.detail}. Run 'npx @alook/app stop' before retrying.`);
        }
      } finally {
        await releaseLifecycleReservation(reservation);
        signalCleanup?.markReservationReleased();
        if (!servicesReady || !devMode) signalCleanup?.dispose();
      }

      const baseURL = WEB_URL(profile.web.business);
      console.log("  ✓ All services ready\n");

      if (email) {
        const { sessionCookie } = await registerUser(baseURL, email);
        const { tokenId } = await createPairingToken(baseURL, sessionCookie);
        console.log("Starting daemon...");
        if (!pairAndStartDaemon(tokenId, ports)) {
          console.warn("  Warning: daemon auto-start failed.");
          console.warn(`  Open ${baseURL}/c/me/machines to generate a new pairing command.`);
        }
      }

      console.log("\n" + "─".repeat(50));
      console.log("\n⚠️  Local mode: email send/receive is not available.");
      console.log("   To enable email, connect to alook.ai cloud.\n");
      console.log("─".repeat(50));
      console.log("\n🎉 Alook is running!");
      console.log(`   Dashboard: ${baseURL}`);
      if (email) console.log(`   Login:     ${email}`);
      console.log("\n   Stop:   npx @alook/app stop");
      console.log("   Start:  npx @alook/app start");
      console.log("   Update: npx @alook/app update\n");

      if (opts.open === false) return;
      const signInURL = `${baseURL}/sign-in`;
      if (email) {
        try {
          execSync(`printf '%s' ${JSON.stringify(email)} | pbcopy`, { stdio: "ignore" });
          console.log("   Email copied to clipboard.\n");
        } catch {
          try {
            execSync(`printf '%s' ${JSON.stringify(email)} | xclip -selection clipboard`, { stdio: "ignore" });
            console.log("   Email copied to clipboard.\n");
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
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      try {
        const openArgs = process.platform === "win32" ? ["/c", "start", "", signInURL] : [signInURL];
        spawnAsync(openCmd, openArgs, { stdio: "ignore", detached: true }).unref();
      } catch {}
    });
}
