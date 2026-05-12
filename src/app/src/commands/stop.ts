import { Command } from "commander";
import { stopServices } from "../lib/services.js";

export function stopCommand(): Command {
  return new Command("stop")
    .description("Stop all Alook services")
    .action(() => {
      console.log("Stopping Alook services...");
      stopServices();
      console.log("\nAll services stopped.");
    });
}
