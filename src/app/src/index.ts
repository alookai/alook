#!/usr/bin/env node
import { Command } from "commander";
import { onboardCommand } from "./commands/onboard.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { updateCommand } from "./commands/update.js";

const program = new Command();

program
  .name("alook-app")
  .description("Run Alook locally — one command, no clone needed")
  .version("0.0.1");

program.addCommand(onboardCommand());
program.addCommand(startCommand());
program.addCommand(stopCommand());
program.addCommand(updateCommand());

program.parse();
