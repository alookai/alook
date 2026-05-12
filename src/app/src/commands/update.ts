import { Command } from "commander";
import { stopServices, isRunning } from "../lib/services.js";
import { installBundled } from "../lib/install.js";
import { runMigrations } from "../lib/migrate.js";

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

      console.log("Running migrations...");
      runMigrations();

      console.log("\n✓ Update complete.");
      console.log("Run 'npx @alook/app start' to restart.");
    });
}
