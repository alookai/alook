import { Command } from "commander";
import { stopServices } from "../lib/services.js";
import { stopSavedDaemons } from "../lib/daemon.js";
import { acquireLifecycleReservation, releaseLifecycleReservation } from "../lib/lifecycle-lock.js";

export function stopCommand(): Command {
  return new Command("stop")
    .description("Stop all Alook services")
    .action(async () => {
      console.log("Stopping Alook services and daemon...");
      const reservation = await acquireLifecycleReservation();
      let serviceResult: Awaited<ReturnType<typeof stopServices>>;
      try {
        serviceResult = await stopServices();
      } finally {
        await releaseLifecycleReservation(reservation);
      }
      const daemonResult = stopSavedDaemons();
      const errors = [
        ...serviceResult.errors,
        ...daemonResult.failed.map((id) => `daemon ${id} did not stop`),
      ];
      if (errors.length > 0) {
        throw new Error(`Alook stop incomplete:\n${errors.map((item) => `- ${item}`).join("\n")}`);
      }
      if (!serviceResult.stopped) console.log("No verified running services found.");
      console.log("\nAll services stopped.");
    });
}
