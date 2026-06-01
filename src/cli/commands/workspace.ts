import { Command } from "commander";
import { readFileSync } from "fs";
import { APIClient } from "../lib/client.js";
import { printJSON } from "../lib/output.js";
import { resolveClientOpts } from "../lib/resolve-client.js";

interface RuntimeResponse {
  id: string;
  machineLastSeenAt?: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

interface StudioResponse {
  studio: { name: string };
  workspace: { id: string; name: string };
  agents: Array<{ id: string; name: string; email_handle: string | null }>;
}

export function workspaceCommand(): Command {
  const cmd = new Command("workspace").description("Manage workspaces");

  cmd
    .command("init")
    .description("Initialize a workspace from a JSON configuration file")
    .requiredOption("--json-file <path>", "Path to the JSON configuration file")
    .option("--name <name>", "Workspace name (overrides JSON)")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command);
      const client = new APIClient(serverUrl, token, workspaceId);

      // Read local JSON file
      let configJson: string;
      try {
        configJson = readFileSync(opts.jsonFile, "utf-8");
      } catch (err) {
        console.error(`Error: cannot read file '${opts.jsonFile}': ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }

      let config: { name?: string; scenario?: string; members: Array<Record<string, unknown>> };
      try {
        config = JSON.parse(configJson);
      } catch {
        console.error("Error: invalid JSON in configuration file");
        process.exit(1);
      }

      if (!config.members || !Array.isArray(config.members) || config.members.length === 0) {
        console.error("Error: JSON must contain a 'members' array with at least one member");
        process.exit(1);
      }

      // Get runtimes for this workspace
      let runtimes: RuntimeResponse[];
      try {
        runtimes = await client.getJSON<RuntimeResponse[]>("/api/runtimes");
      } catch (err) {
        console.error(`Error: failed to fetch runtimes: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }

      if (runtimes.length === 0) {
        console.error("Error: No daemon registered. Run 'npx @alook/cli daemon start' first.");
        process.exit(1);
      }

      // Pick the first online runtime, or first one if none are online
      const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
      const now = Date.now();
      const onlineRuntime = runtimes.find((r) => {
        if (!r.machineLastSeenAt) return false;
        const lastSeen = new Date(r.machineLastSeenAt.includes("Z") ? r.machineLastSeenAt : r.machineLastSeenAt + "Z").getTime();
        return now - lastSeen < OFFLINE_THRESHOLD_MS;
      });
      let runtime = onlineRuntime || runtimes[0];

      // Check if workspace already has agents — if so, create a new workspace
      let targetWorkspaceId = workspaceId;
      let targetClient = client;
      try {
        const agents = await client.getJSON<Array<{ id: string }>>(`/api/agents?workspace_id=${workspaceId}`);
        if (agents.length > 0) {
          console.log("Current workspace has existing agents. Creating a new workspace...");
          const wsName = opts.name || config.name || "New Workspace";
          const newWs = await client.postJSON<{ id: string; name: string }>("/api/workspaces", { name: wsName, slug: slugify(wsName) });
          targetWorkspaceId = newWs.id;
          targetClient = new APIClient(serverUrl, token, targetWorkspaceId);
          console.log(`Created workspace: ${newWs.name} (${newWs.id})`);

          // Re-fetch runtimes scoped to the new workspace
          try {
            const newRuntimes = await targetClient.getJSON<RuntimeResponse[]>("/api/runtimes");
            if (newRuntimes.length > 0) {
              const newOnlineRuntime = newRuntimes.find((r) => {
                if (!r.machineLastSeenAt) return false;
                const lastSeen = new Date(r.machineLastSeenAt.includes("Z") ? r.machineLastSeenAt : r.machineLastSeenAt + "Z").getTime();
                return now - lastSeen < OFFLINE_THRESHOLD_MS;
              });
              runtime = newOnlineRuntime || newRuntimes[0];
            } else {
              await targetClient.postJSON("/api/runtimes", { id: runtime.id });
            }
          } catch (err) {
            console.warn(`Warning: could not refresh runtimes for new workspace: ${err instanceof Error ? err.message : err}`);
          }
        }
      } catch (err) {
        console.warn(`Warning: could not check existing agents: ${err instanceof Error ? err.message : err}`);
      }

      // Inject runtime_id into each member
      const members = config.members.map((m) => ({
        ...m,
        runtime_id: runtime.id,
      }));

      const payload = {
        name: opts.name || config.name,
        scenario: config.scenario,
        members,
      };

      // POST to /api/studios
      try {
        const res = await targetClient.postJSON<StudioResponse>("/api/studios", payload);

        if (opts.json) return printJSON(res);

        console.log(`\nWorkspace initialized: ${res.studio.name || res.workspace.name}`);
        console.log("Agents created:");
        for (const agent of res.agents) {
          const email = agent.email_handle ? `${agent.email_handle}@alook.ai` : "no email";
          console.log(`  - ${agent.name} (${email})`);
        }
      } catch (err) {
        console.error(`Error: failed to create workspace: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  return cmd;
}
