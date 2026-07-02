/**
 * `pnpm run daemon` — LOCAL-DEV daemon entry.
 *
 * Thin wrapper over the published CLI's `daemon start` command so the same
 * flags work in dev (e.g. `pn daemon start --machine-key … --server-url …
 * --ws-url …`). All three flags are required — set ALOOK_MACHINE_KEY /
 * ALOOK_SERVER_URL / ALOOK_SERVER_WS_URL or pass the matching options.
 */
import { Command } from "commander";
import { daemonStart } from "../src/cli/daemonStart";
import { createLogger } from "../src/logger";

const log = createLogger({ header: "@alook/daemon" });

const program = new Command();
program
  .name("daemon")
  .description("local-dev daemon entry (wraps `alook daemon …`)");

program
  .command("start")
  .description("start the daemon")
  .requiredOption("--machine-key <key>", "machine key (or ALOOK_MACHINE_KEY)", process.env.ALOOK_MACHINE_KEY)
  .option("--server-url <url>", "server HTTP URL (or ALOOK_SERVER_URL)", process.env.ALOOK_SERVER_URL)
  .option("--ws-url <url>", "server WebSocket URL (or ALOOK_SERVER_WS_URL)", process.env.ALOOK_SERVER_WS_URL)
  .option("--base-dir <path>", "data directory (or ALOOK_DATA_DIR)", process.env.ALOOK_DATA_DIR)
  .action(async (opts: { machineKey: string; serverUrl?: string; wsUrl?: string; baseDir?: string }) => {
    await daemonStart({
      machineKey: opts.machineKey,
      serverUrl: opts.serverUrl,
      wsUrl: opts.wsUrl,
      baseDir: opts.baseDir,
    });
  });

program.parseAsync(process.argv).catch((e) => {
  log.error((e as Error).message ?? String(e));
  process.exit(1);
});
