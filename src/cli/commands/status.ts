import { Command } from "commander";
import { loadCLIConfigForProfile, activeWorkspaces } from "../lib/config.js";
import { cmdPrefix } from "../lib/env.js";

export function statusCommand(): Command {
  const cmd = new Command("status")
    .description("Show registration status")
    .action((_opts, command) => {
      const profile: string | undefined = command.parent?.opts().profile;
      const cfg = loadCLIConfigForProfile(profile);

      const ws = activeWorkspaces(cfg.watched_workspaces)[0];
      if (!ws?.token) {
        console.log("Not registered");
        console.log(
          `Run '${cmdPrefix()} register --token <token>' to register.`,
        );
        return;
      }

      console.log("Status: Registered");
      console.log(`Server: ${cfg.server_url}`);
      console.log(`Workspace: ${ws.name} (${ws.id})`);
    });

  return cmd;
}
