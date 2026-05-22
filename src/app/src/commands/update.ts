import { Command } from "commander";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { startServices, stopServices, isRunning } from "../lib/services.js";
import { installBundled } from "../lib/install.js";
import { ensureSecrets } from "../lib/secrets.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";
import { runMigrations } from "../lib/migrate.js";
import { buildCliEnv } from "../lib/cli-env.js";
import { DEFAULT_PORTS } from "../lib/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function cliEntry(): string {
  return join(__dirname, "cli", "index.js");
}

function runDaemon(args: string[], quiet = false): { ok: boolean; output: string } {
  const result = spawnSync("node", [cliEntry(), "daemon", ...args], {
    stdio: quiet ? ["pipe", "pipe", "pipe"] : "inherit",
    env: buildCliEnv(),
  });
  const output = quiet ? (result.stdout?.toString() ?? "") : "";
  return { ok: result.status === 0, output };
}

function isDaemonRunning(): boolean {
  const { output } = runDaemon(["status"], true);
  return output.includes("running (pid=");
}

export function updateCommand(): Command {
  return new Command("update")
    .description("Update Alook to the latest version")
    .action(() => {
      console.log("Updating Alook...\n");

      // Stop daemon if running (so it doesn't hold the health port)
      const daemonWasRunning = isDaemonRunning();
      if (daemonWasRunning) {
        console.log("Stopping daemon...");
        runDaemon(["stop"]);
      }

      const servicesWereRunning = isRunning();
      if (servicesWereRunning) {
        console.log("Stopping running services...");
        stopServices();
      }

      console.log("Installing latest version...");
      installBundled();

      ensureSecrets(DEFAULT_PORTS.web);
      patchWranglerConfigs(DEFAULT_PORTS);

      console.log("Running migrations...");
      runMigrations();

      // Restart services that were running before the update
      if (servicesWereRunning) {
        console.log("Restarting services...");
        startServices(DEFAULT_PORTS);
      }

      if (daemonWasRunning) {
        console.log("Restarting daemon...");
        runDaemon(["start"]);
      }

      console.log("\n✓ Update complete.");
      if (!servicesWereRunning) {
        console.log("Run 'npx @alook/app start' to start services.");
      }
    });
}
