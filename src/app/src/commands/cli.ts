import { Command } from "commander";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_PORTS, WEB_URL, SELF_HOSTED_DIR } from "../lib/constants.js";
import { readPids } from "../lib/pid.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findCliEntry(): string {
  return join(__dirname, "cli", "index.js");
}

function getWebPort(): number {
  const state = readPids();
  return state.ports?.web ?? DEFAULT_PORTS.web;
}

function runCli(args: string[]): void {
  const result = spawnSync("node", [findCliEntry(), ...args], {
    stdio: "inherit",
    env: {
      ...process.env as Record<string, string>,
      ALOOK_SERVER_URL: WEB_URL(getWebPort()),
      ALOOK_PROJECT_ROOT: SELF_HOSTED_DIR,
      ALOOK_CMD_PREFIX: "npx @alook/app cli",
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

export function cliPassthroughCommand(): Command {
  return new Command("cli")
    .description("Run any @alook/cli command against the local server")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]")
    .action((args) => {
      runCli(args);
    });
}
