/**
 * `pnpm run daemon` — LOCAL-DEV daemon entry.
 *
 * Detects all available runtimes, lets the user pick one via ALOOK_RUNTIME env
 * (or prompts interactively if multiple are available), then starts the daemon.
 *
 * Requires: `pnpm run mock-server` running (or a real server at the URLs).
 */
import * as path from "path";
import * as readline from "readline";
import { WebSocket } from "ws";
import { createDaemon } from "../src/daemon/createDaemon";
import { getDriver } from "../src/drivers/index";
import { resolveAlookCliPathWithFallback, detectRuntimes } from "../src/discovery";
import { createLogger } from "../src/logger";
import type { RuntimeId } from "../src/drivers/index";

const MACHINE_KEY = process.env.ALOOK_MACHINE_KEY;
const SERVER_URL = process.env.ALOOK_SERVER_URL;
const SERVER_WS_URL = process.env.ALOOK_SERVER_WS_URL;
const RUNTIME_OVERRIDE = process.env.ALOOK_RUNTIME;

const CAPABILITIES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge"];
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const WORKING_DIR_BASE = path.join(PROJECT_ROOT, ".alook", "daemon");

const log = createLogger({ header: "@alook/daemon" });

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectRuntime(available: RuntimeId[]): Promise<RuntimeId> {
  // If env override is set, use it
  if (RUNTIME_OVERRIDE) {
    if (!available.includes(RUNTIME_OVERRIDE as RuntimeId)) {
      log.error(`ALOOK_RUNTIME=${RUNTIME_OVERRIDE} is not available. Available: ${available.join(", ")}`);
      process.exit(2);
    }
    return RUNTIME_OVERRIDE as RuntimeId;
  }

  // Single runtime — use it directly
  if (available.length === 1) {
    return available[0];
  }

  // Multiple runtimes — prompt user
  console.log("\nAvailable runtimes:");
  available.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  const answer = await promptUser(`\nSelect runtime [1-${available.length}]: `);
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= available.length) {
    log.error(`invalid selection: "${answer}"`);
    process.exit(2);
  }
  return available[idx];
}

async function main() {
  if (!MACHINE_KEY || !SERVER_URL || !SERVER_WS_URL) {
    log.error("ALOOK_MACHINE_KEY + ALOOK_SERVER_URL + ALOOK_SERVER_WS_URL are required");
    process.exit(2);
  }

  // Auto-discover agent CLI
  const agentCliPath = resolveAlookCliPathWithFallback() ?? path.resolve(import.meta.dirname, "alook-shim.mjs");
  log.info(`agent CLI: ${agentCliPath}`);

  // Detect and display runtimes
  const allRuntimes = await detectRuntimes();
  const available = allRuntimes.filter((r) => r.available);

  if (available.length === 0) {
    log.error("no runtimes detected — install at least one (claude, codex, gemini, etc.)");
    process.exit(2);
  }

  log.info(`detected runtimes: ${available.map((r) => `${r.id}${r.version ? ` (${r.version})` : ""}`).join(", ")}`);

  // Let user select
  const selectedRuntime = await selectRuntime(available.map((r) => r.id));
  log.info(`using runtime: ${selectedRuntime}`);

  const daemon = await createDaemon({
    machineKey: MACHINE_KEY,
    serverUrl: SERVER_URL,
    serverWsUrl: SERVER_WS_URL,
    webSocketFactory: (url, headers) => new WebSocket(url, { headers }),
    runtimes: [selectedRuntime],
    driverFor: () => getDriver(selectedRuntime),
    capabilities: CAPABILITIES,
    agentCliPath,
    workingDirectoryBase: WORKING_DIR_BASE,
  });

  log.info(`daemon up — proxy at ${daemon.proxyUrl}, workdir=${WORKING_DIR_BASE}, dialing ${SERVER_WS_URL}`);

  const readyTimer = setInterval(() => {
    if (daemon.isOpen()) {
      clearInterval(readyTimer);
      log.info(`control plane OPEN — routing to ${selectedRuntime} agents`);
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
