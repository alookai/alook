import { Command } from "commander";
import { checkPorts } from "../lib/checks.js";
import { isInstalled } from "../lib/install.js";
import { startServices, isRunning } from "../lib/services.js";
import { DEFAULT_PORTS, WEB_URL } from "../lib/constants.js";

export function startCommand(): Command {
  return new Command("start")
    .description("Start Alook services")
    .option("--port-web <port>", "Web server port", String(DEFAULT_PORTS.web))
    .option("--port-email <port>", "Email worker port", String(DEFAULT_PORTS.emailWorker))
    .option("--port-ws <port>", "WebSocket worker port", String(DEFAULT_PORTS.wsDo))
    .action(async (opts) => {
      if (!isInstalled()) {
        console.error("Error: Alook not installed. Run 'npx @alook/app onboard' first.");
        process.exit(1);
      }

      if (isRunning()) {
        console.log("Services already running.");
        return;
      }

      const ports = {
        web: parseInt(opts.portWeb, 10),
        emailWorker: parseInt(opts.portEmail, 10),
        wsDo: parseInt(opts.portWs, 10),
      };

      await checkPorts(ports);
      startServices(ports, { foreground: !!process.env.ALOOK_PROJECT_ROOT });

      console.log(`\nDashboard: ${WEB_URL(ports.web)}`);
    });
}
