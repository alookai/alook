import { Command } from "commander";
import { startServices, stopServices, isRunning } from "../lib/services.js";
import { prepareSelfHosted } from "../lib/prepare-self-hosted.js";
import { DEFAULT_PORTS } from "../lib/constants.js";

export function updateCommand(): Command {
  return new Command("update")
    .description("Update Alook to the latest version")
    .action(() => {
      console.log("Updating Alook...\n");

      const servicesWereRunning = isRunning();
      if (servicesWereRunning) {
        console.log("Stopping running services...");
        stopServices();
      }

      prepareSelfHosted(DEFAULT_PORTS, true);

      if (servicesWereRunning) {
        console.log("Restarting services...");
        startServices(DEFAULT_PORTS);
      }

      console.log("\n✓ Update complete.");
      if (!servicesWereRunning) {
        console.log("Run 'npx @alook/app start' to start services.");
      }
    });
}
