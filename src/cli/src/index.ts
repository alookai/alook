#!/usr/bin/env node
import { Command } from "commander";
import { registerCommand } from "../commands/register.js";
import { loginCommand } from "../commands/login.js";
import { statusCommand } from "../commands/status.js";
import { daemonCommand } from "../commands/daemon.js";
import { configCommand } from "../commands/config.js";
import { emailCommand } from "../commands/email.js";
import { calendarCommand } from "../commands/calendar.js";
import { issueCommand } from "../commands/issue.js";
import { agentCommand } from "../commands/agent.js";
import { versionCommand } from "../commands/version.js";
import { updateCommand } from "../commands/update.js";
import { syncCommand } from "../commands/sync.js";

const program = new Command();

program
  .name("alook")
  .description("Alook CLI")
  .option("--server <url>", "Server URL")
  .option("--profile <name>", "Profile name");

program.addCommand(registerCommand());
program.addCommand(loginCommand());
program.addCommand(statusCommand());
program.addCommand(daemonCommand());
program.addCommand(emailCommand());
program.addCommand(calendarCommand());
program.addCommand(issueCommand());
program.addCommand(agentCommand());
program.addCommand(configCommand());
program.addCommand(versionCommand());
program.addCommand(updateCommand());
program.addCommand(syncCommand());

program.parse();
