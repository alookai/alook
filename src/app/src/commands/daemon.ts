import { Command } from "commander";
import { runEmbeddedDaemon } from "../lib/daemon.js";

function delegate(args: string[]): never {
  const result = runEmbeddedDaemon(args);
  process.exit(result.ok ? 0 : 1);
}

export function daemonCommand(): Command {
  const daemon = new Command("daemon")
    .description("Manage the local Alook daemon")
    .enablePositionalOptions();

  daemon
    .command("start")
    .description("Pair a new daemon or restart a saved machine")
    .allowUnknownOption()
    .passThroughOptions()
    .argument("[args...]")
    .action((args) => delegate(["start", ...args]));

  daemon
    .command("stop")
    .description("Stop a daemon by machine id")
    .argument("<id>")
    .action((id) => delegate(["stop", id]));

  daemon
    .command("list")
    .description("List local daemons")
    .option("--json", "Print a machine-readable JSON envelope")
    .action((opts) => delegate(["list", ...(opts.json ? ["--json"] : [])]));

  daemon
    .command("status")
    .description("Show daemon agent status")
    .argument("[id]")
    .action((id) => delegate(["status", ...(id ? [id] : [])]));

  return daemon;
}
