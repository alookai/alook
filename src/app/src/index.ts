#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { onboardCommand } from "./commands/onboard.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { updateCommand } from "./commands/update.js";
import { registerCommand, daemonCommand, cliPassthroughCommand } from "./commands/cli.js";

function getVersion(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(__dirname, "..", "package.json"), join(__dirname, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
      if (pkg.version) return pkg.version;
    } catch {}
  }
  return "0.0.0";
}

const program = new Command();

program
  .name("alook-app")
  .description("Run Alook locally — one command, no clone needed")
  .version(getVersion())
  .enablePositionalOptions();

program.addCommand(onboardCommand());
program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(updateCommand());
program.addCommand(registerCommand());
program.addCommand(daemonCommand());
program.addCommand(cliPassthroughCommand());

program.parse();
