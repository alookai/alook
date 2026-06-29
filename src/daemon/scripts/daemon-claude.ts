/**
 * `pnpm run daemon` — LOCAL-DEV daemon entry with REAL Claude runtime.
 *
 * This is a THIN launcher: it reads env vars and calls `createDaemon` with a
 * real `ClaudeDriver`. ALL daemon logic lives in `src/daemon/createDaemon.ts` —
 * this file does NOT assemble broker/proxy/channel/manager by hand.
 *
 * Requires: `pnpm run mock-server` running (or a real server at the URLs).
 */
import * as path from "path";
import { WebSocket } from "ws";
import { createDaemon } from "../src/daemon/createDaemon";
import { ClaudeDriver } from "../src/drivers/claude";
import { createLogger } from "../src/logger";

const MACHINE_KEY = process.env.ALOOK_MACHINE_KEY;
const SERVER_URL = process.env.ALOOK_SERVER_URL;
const SERVER_WS_URL = process.env.ALOOK_SERVER_WS_URL;

const CAPABILITIES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge"];
const HOST_CLI_PATH = path.resolve(import.meta.dirname, "alook-shim.mjs");
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const WORKING_DIR_BASE = path.join(PROJECT_ROOT, ".alook", "daemon");

const log = createLogger({ header: "@alook/daemon" });

async function main() {
  if (!MACHINE_KEY || !SERVER_URL || !SERVER_WS_URL) {
    log.error("ALOOK_MACHINE_KEY + ALOOK_SERVER_URL + ALOOK_SERVER_WS_URL are required");
    process.exit(2);
  }

  const driver = new ClaudeDriver();

  const daemon = await createDaemon({
    machineKey: MACHINE_KEY,
    serverUrl: SERVER_URL,
    serverWsUrl: SERVER_WS_URL,
    webSocketFactory: (url, headers) => new WebSocket(url, { headers }),
    runtimes: ["claude"],
    driverFor: () => driver,
    capabilities: CAPABILITIES,
    agentCliPath: HOST_CLI_PATH,
    workingDirectoryBase: WORKING_DIR_BASE,
  });

  log.info(`daemon up — proxy at ${daemon.proxyUrl}, workdir=${WORKING_DIR_BASE}, dialing ${SERVER_WS_URL}`);

  const readyTimer = setInterval(() => {
    if (daemon.isOpen()) {
      clearInterval(readyTimer);
      log.info("control plane OPEN — routing to real Claude agents");
    }
  }, 200);
  readyTimer.unref?.();

  const shutdown = async () => {
    log.info("shutting down…");
    clearInterval(readyTimer);
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error((e as Error).message ?? String(e));
  process.exit(1);
});
