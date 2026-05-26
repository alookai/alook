import { Command } from "commander";

export function getRootOpts(command: Command): Record<string, unknown> {
  let root = command;
  while (root.parent) root = root.parent;
  return root.opts() || {};
}
