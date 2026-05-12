import { Command } from "commander";
import { stopServices, isRunning } from "../lib/services.js";
import { installBundled } from "../lib/install.js";
import { ensureSecrets } from "../lib/secrets.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";
import { runMigrations } from "../lib/migrate.js";
import { DEFAULT_PORTS } from "../lib/constants.js";

export function updateCommand(): Command {
  return new Command("update")
    .description("Update Alook to the latest version")
    .action(() => {
      console.log("Updating Alook...\n");

      if (isRunning()) {
        console.log("Stopping running services...");
        stopServices();
      }

      console.log("Installing latest version...");
      installBundled();

      ensureSecrets(DEFAULT_PORTS.web);
      patchWranglerConfigs(DEFAULT_PORTS);

      console.log("Running migrations...");
      runMigrations();

      console.log("\n✓ Update complete.");
      console.log("Run 'npx @alook/app start' to restart.");
    });
}
