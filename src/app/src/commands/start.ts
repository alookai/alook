import { Command } from "commander";
import { checkPorts, validateServicePortProfile } from "../lib/checks.js";
import { isInstalled } from "../lib/install.js";
import { inspectServices, startServices } from "../lib/services.js";
import { createServicePortProfile, DEFAULT_PORTS, WEB_URL } from "../lib/constants.js";
import {
  waitForExistingServices,
  waitForOwnedServices,
  installOwnedSignalCleanup,
  type OwnedSignalCleanup,
} from "../lib/startup.js";
import { startSavedDaemons } from "../lib/daemon.js";
import { acquireLifecycleReservation, releaseLifecycleReservation } from "../lib/lifecycle-lock.js";
import { clearRegistry } from "../lib/pid.js";

export function startCommand(): Command {
  return new Command("start")
    .description("Start Alook services")
    .option("--port-web <port>", "Web server port", String(DEFAULT_PORTS.web))
    .option("--port-email <port>", "Email worker port", String(DEFAULT_PORTS.emailWorker))
    .option("--port-ws <port>", "WebSocket worker port", String(DEFAULT_PORTS.wsDo))
    .option("--port-wake <port>", "Wake worker port", String(DEFAULT_PORTS.wakeWorker))
    .action(async (opts) => {
      if (!isInstalled()) throw new Error("Alook not installed. Run 'npx @alook/app onboard' first.");
      const ports = {
        web: parseInt(opts.portWeb, 10),
        emailWorker: parseInt(opts.portEmail, 10),
        wsDo: parseInt(opts.portWs, 10),
        wakeWorker: parseInt(opts.portWake, 10),
      };
      const profile = createServicePortProfile(ports);
      validateServicePortProfile(profile);
      const foreground = !!process.env.ALOOK_PROJECT_ROOT;
      const reservation = await acquireLifecycleReservation();
      let ownedHandle: Awaited<ReturnType<typeof startServices>> | undefined;
      let signalCleanup: OwnedSignalCleanup | undefined;
      let servicesReady = false;
      try {
        const inspection = await inspectServices(profile);
        if (inspection.state === "reusable") {
          await waitForExistingServices(inspection.registry);
          console.log("Services already running and healthy.");
        } else if (inspection.state === "none" || inspection.state === "stale") {
          if (inspection.state === "stale") clearRegistry(inspection.registry.runId);
          await checkPorts(profile);
          ownedHandle = await startServices(profile, {
            foreground,
            onHandle: (handle) => {
              signalCleanup = installOwnedSignalCleanup(handle, reservation);
            },
          });
          await waitForOwnedServices(ownedHandle);
          servicesReady = true;
        } else {
          throw new Error(`${inspection.state}: ${inspection.detail}. Run 'npx @alook/app stop' before retrying.`);
        }
      } finally {
        await releaseLifecycleReservation(reservation);
        signalCleanup?.markReservationReleased();
        if (!servicesReady || !foreground) signalCleanup?.dispose();
      }

      const daemonResult = startSavedDaemons();
      if (daemonResult.failed.length > 0) console.warn(`Could not start daemon(s): ${daemonResult.failed.join(", ")}`);
      console.log(`\nDashboard: ${WEB_URL(profile.web.business)}`);
    });
}
