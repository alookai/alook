import { addServicePortOptions, servicePortsFromOptions } from "../lib/service-topology.js";
import { Command } from "commander";
import { checkPorts } from "../lib/checks.js";
import { isInstalled } from "../lib/install.js";
import { startServices, isRunning } from "../lib/services.js";
import { DEFAULT_PORTS, WEB_URL } from "../lib/constants.js";
import { waitForServer } from "../lib/register.js";
import { startSavedDaemons } from "../lib/daemon.js";

export function startCommand(): Command {
  return addServicePortOptions(new Command("start").description("Start Alook services"), DEFAULT_PORTS)
    .action(async (opts) => {
      if (!isInstalled()) {
        console.error("Error: Alook not installed. Run 'npx @alook/app onboard' first.");
        process.exit(1);
      }

      const ports = servicePortsFromOptions(opts);

      const alreadyRunning = isRunning();
      if (alreadyRunning) {
        console.log("Services already running.");
      } else {
        await checkPorts(ports);
        startServices(ports, { foreground: !!process.env.ALOOK_PROJECT_ROOT });
        await waitForServer(WEB_URL(ports.web));
      }

      const daemonResult = startSavedDaemons();
      if (daemonResult.failed.length > 0) {
        console.warn(`Could not start daemon(s): ${daemonResult.failed.join(", ")}`);
      }

      console.log(`\nDashboard: ${WEB_URL(ports.web)}`);
    });
}
