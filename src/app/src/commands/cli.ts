import { Command } from "commander";
import { spawnSync } from "child_process";
import { DEFAULT_PORTS, WEB_URL } from "../lib/constants.js";

function runCli(args: string[]): void {
  const result = spawnSync("npx", ["@alook/cli", ...args], {
    stdio: "inherit",
    env: {
      ...process.env as Record<string, string>,
      ALOOK_SERVER_URL: WEB_URL(DEFAULT_PORTS.web),
    },
  });
  process.exit(result.status ?? 1);
}

export function registerCommand(): Command {
  return new Command("register")
    .description("Register CLI with local Alook server")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]")
    .action((args) => {
      runCli(["register", ...args]);
    });
}

export function daemonCommand(): Command {
  const daemon = new Command("daemon")
    .description("Manage the local Alook daemon")
    .enablePositionalOptions();

  daemon
    .command("start")
    .description("Start the daemon")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]")
    .action((args) => {
      runCli(["daemon", "start", ...args]);
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(() => {
      runCli(["daemon", "stop"]);
    });

  daemon
    .command("status")
    .description("Check daemon status")
    .action(() => {
      runCli(["daemon", "status"]);
    });

  return daemon;
}
