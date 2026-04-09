import { Command } from "commander";
import { APIClient } from "../lib/client.js";
import { saveCLIConfigForProfile } from "../lib/config.js";

interface MeResponse {
  id: string;
  email: string;
}

interface Workspace {
  id: string;
  name: string;
}

export function registerCommand(): Command {
  const cmd = new Command("register")
    .description("Register CLI with your Alook account")
    .requiredOption("--token <token>", "API token (starts with al_)")
    .option("--server <url>", "Server URL")
    .option("--profile <name>", "Profile name")
    .action(async (opts, command) => {
      const token: string = opts.token;
      const profile: string | undefined =
        opts.profile || command.parent?.opts().profile;
      const serverUrl: string =
        opts.server ||
        command.parent?.opts().server ||
        "http://localhost:3000";

      if (!token) {
        console.error(
          "Error: --token is required\nUsage: alook register --token <token>",
        );
        process.exit(1);
      }

      if (!token.startsWith("al_")) {
        console.error(
          "Error: invalid token format: must start with 'al_'",
        );
        process.exit(1);
      }

      const client = new APIClient(serverUrl, token);

      let me: MeResponse;
      try {
        me = await client.getJSON<MeResponse>("/api/me");
      } catch (err) {
        console.error(
          `Error: failed to verify token: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      let workspaces: Workspace[];
      try {
        workspaces = await client.getJSON<Workspace[]>("/api/workspaces");
      } catch (err) {
        console.error(
          `Error: failed to fetch workspaces: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      if (!workspaces.length) {
        console.error("Error: no workspaces found for this user");
        process.exit(1);
      }

      const ws = workspaces[0];

      saveCLIConfigForProfile(profile, {
        token,
        server_url: serverUrl,
        watched_workspaces: [{ id: ws.id, name: ws.name }],
      });

      console.log(`Registered as ${me.email}`);
      console.log(`Workspace: ${ws.name} (${ws.id})`);
      console.log();
      console.log(
        "Run 'alook daemon start --foreground' to start the daemon.",
      );
    });

  return cmd;
}
