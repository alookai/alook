import { Command } from "commander";
import { inspectServices, startServices, stopServices } from "../lib/services.js";
import { installBundled } from "../lib/install.js";
import { ensureSecrets } from "../lib/secrets.js";
import { patchWranglerConfigs } from "../lib/wrangler-config.js";
import { runMigrations } from "../lib/migrate.js";
import { DEFAULT_SERVICE_PROFILE } from "../lib/constants.js";
import { acquireLifecycleReservation, releaseLifecycleReservation } from "../lib/lifecycle-lock.js";
import { checkPorts } from "../lib/checks.js";
import { clearRegistry } from "../lib/pid.js";
import { installOwnedSignalCleanup, waitForOwnedServices, type OwnedSignalCleanup } from "../lib/startup.js";

export function updateCommand(): Command {
  return new Command("update")
    .description("Update Alook to the latest version")
    .action(async () => {
      console.log("Updating Alook...\n");
      const reservation = await acquireLifecycleReservation();
      let signalCleanup: OwnedSignalCleanup | undefined;
      try {
        const inspection = await inspectServices();
        if (inspection.state === "partial" || inspection.state === "profile-mismatch" || inspection.state === "recovery-required") {
          throw new Error(`${inspection.state}: ${inspection.detail}. Run 'npx @alook/app stop' before retrying.`);
        }
        const runningRegistry = inspection.state === "reusable" ? inspection.registry : undefined;
        const profile = runningRegistry?.profile ?? DEFAULT_SERVICE_PROFILE;
        if (inspection.state === "stale") clearRegistry(inspection.registry.runId);

        if (runningRegistry) {
          console.log("Stopping running services...");
          const stopped = await stopServices();
          if (!stopped.stopped || stopped.errors.length > 0) {
            throw new Error(`could not stop the existing generation: ${stopped.errors.join("; ")}`);
          }
        }

        console.log("Installing latest version...");
        installBundled();
        ensureSecrets(profile.web.business);
        patchWranglerConfigs(profile);
        console.log("Running migrations...");
        runMigrations();

        if (runningRegistry) {
          console.log("Restarting services...");
          await checkPorts(profile);
          const handle = await startServices(profile, {
            onHandle: (owned) => {
              signalCleanup = installOwnedSignalCleanup(owned, reservation);
            },
          });
          await waitForOwnedServices(handle);
        }

        console.log("\n✓ Update complete.");
        if (!runningRegistry) console.log("Run 'npx @alook/app start' to start services.");
      } finally {
        await releaseLifecycleReservation(reservation);
        signalCleanup?.markReservationReleased();
        signalCleanup?.dispose();
      }
    });
}
