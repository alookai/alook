import { Command } from "commander";
import { APIClient } from "../lib/client.js";
import { cmdPrefix, getServerUrl } from "../lib/env.js";
import { activateAndSave } from "../lib/activate.js";

interface MeResponse {
  id: string;
  email: string;
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
        getServerUrl();

      if (!token) {
        console.error(
          `Error: --token is required\nUsage: ${cmdPrefix()} register --token <token>`,
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

      // Verify token
      let me: MeResponse;
      try {
        me = await client.getJSON<MeResponse>("/api/me");
      } catch (err) {
        console.error(
          `Error: failed to verify token: ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }

      const result = await activateAndSave({ token, serverUrl, profile });

      console.log(`\nRegistered as ${me.email}`);
      console.log(`Machine: ${result.daemonId} (status: ${result.tokenStatus})`);
      console.log(`Workspace binding will happen when you launch a company.`);
    });

  return cmd;
}
