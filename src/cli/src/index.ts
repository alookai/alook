#!/usr/bin/env node
import { Command } from "commander";
import { registerCommand } from "../commands/register.js";
import { statusCommand } from "../commands/status.js";
import { daemonCommand } from "../commands/daemon.js";
import { configCommand } from "../commands/config.js";
import { emailCommand } from "../commands/email.js";
import { versionCommand } from "../commands/version.js";

const program = new Command();

program
  .name("alook")
  .description("Alook CLI")
  .option("--server <url>", "Server URL")
  .option("--profile <name>", "Profile name");

program.addCommand(registerCommand());
program.addCommand(statusCommand());
program.addCommand(daemonCommand());
program.addCommand(emailCommand());
program.addCommand(configCommand());
program.addCommand(versionCommand());

program.parse();
