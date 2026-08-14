import { Command } from "commander";
import { stopServices } from "../lib/services.js";
import { stopSavedDaemons } from "../lib/daemon.js";

export function stopCommand(): Command {
  return new Command("stop")
    .description("Stop all Alook services")
    .action(() => {
      console.log("Stopping Alook services and daemon...");
      const daemonResult = stopSavedDaemons();
      stopServices();
      if (daemonResult.failed.length > 0) {
        console.warn(`Could not stop daemon(s): ${daemonResult.failed.join(", ")}`);
      }
      console.log("\nAll services stopped.");
    });
}
