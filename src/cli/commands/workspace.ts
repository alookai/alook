import { Command } from "commander";
import { readFileSync } from "fs";
import { toAlookAddress } from "@alook/shared";
import { APIClient } from "../lib/client.js";
import { cmdPrefix } from "../lib/env.js";
import { printJSON } from "../lib/output.js";
import { resolveClientOptsPartial } from "../lib/resolve-client.js";
import { loadCLIConfigForProfile, saveCLIConfigForProfile } from "../lib/config.js";
import { getRootOpts } from "../lib/command-utils.js";

interface RuntimeResponse {
  id: string;
  machineLastSeenAt?: string | null;
}

interface WorkspaceResponse {
  id: string;
  name: string;
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
  workspace: { id: string; name: string; slug: string };
  agents: Array<{ id: string; name: string; email_handle: string | null }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveWorkspaceId(client: APIClient, configName?: string): Promise<{ workspaceId: string; created: boolean }> {
  let workspaces: WorkspaceResponse[];
  try {
    workspaces = await client.getJSON<WorkspaceResponse[]>("/api/workspaces");
  } catch (err) {
    console.error(`Error: failed to fetch workspaces: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Find an empty workspace (no agents)
  for (const ws of workspaces) {
    try {
      const agents = await client.getJSON<Array<{ id: string }>>(`/api/agents?workspace_id=${ws.id}`);
      if (agents.length === 0) {
        return { workspaceId: ws.id, created: false };
      }
    } catch {
      // Skip workspaces we can't check
    }
  }

  // No empty workspace — create one
  const wsName = configName || "Personal";
  try {
    const newWs = await client.postJSON<{ id: string; name: string }>("/api/workspaces", { name: wsName, slug: slugify(wsName) });
    console.log(`Created workspace: ${newWs.name} (${newWs.id})`);
    return { workspaceId: newWs.id, created: true };
  } catch (err) {
    console.error(`Error: failed to create workspace: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
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
      const { serverUrl, token, workspaceId: resolvedWorkspaceId } = resolveClientOptsPartial(command);
      const client = new APIClient(serverUrl, token, resolvedWorkspaceId);

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

      // Self-resolve workspace if not available from config/env
      let targetWorkspaceId = resolvedWorkspaceId;
      if (!targetWorkspaceId) {
        const resolved = await resolveWorkspaceId(client, opts.name || config.name);
        targetWorkspaceId = resolved.workspaceId;

        // If machine token is in "registered" status, bind it to this workspace
        const parentOpts = getRootOpts(command) as { profile?: string };
        const cfg = loadCLIConfigForProfile(parentOpts.profile);
        const registeredWs = cfg.watched_workspaces?.find((w) => w.status === "registered" && !w.id);
        if (registeredWs) {
          try {
            await client.postJSON("/api/machine-tokens/bind-workspace", { workspace_id: targetWorkspaceId });
            console.log("Machine token bound to workspace. Waiting for runtime registration...");
          } catch (err) {
            console.warn(`Warning: bind-workspace failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        // Poll for runtime to appear
        let runtimes: RuntimeResponse[] = [];
        const wsClient = new APIClient(serverUrl, token, targetWorkspaceId);
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            runtimes = await wsClient.getJSON<RuntimeResponse[]>("/api/runtimes");
            if (runtimes.length > 0) break;
          } catch {
            // Retry
          }
          await sleep(1000);
        }

        if (runtimes.length === 0) {
          console.error(`Error: No daemon registered after waiting. Run '${cmdPrefix()} daemon start' first.`);
          process.exit(1);
        }

        // Pick runtime and continue
        const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000;
        const now = Date.now();
        const onlineRuntime = runtimes.find((r) => {
          if (!r.machineLastSeenAt) return false;
          const lastSeen = new Date(r.machineLastSeenAt.includes("Z") ? r.machineLastSeenAt : r.machineLastSeenAt + "Z").getTime();
          return now - lastSeen < OFFLINE_THRESHOLD_MS;
        });
        const runtime = onlineRuntime || runtimes[0];

        const members = config.members.map((m) => ({
          ...m,
          runtime_id: runtime.id,
        }));

        const payload = {
          name: opts.name || config.name,
          scenario: config.scenario,
          members,
        };

        try {
          const res = await wsClient.postJSON<StudioResponse>("/api/studios", payload);

          // Update local config with the resolved workspace
          try {
            const freshCfg = loadCLIConfigForProfile(parentOpts.profile);
            const watched = freshCfg.watched_workspaces || [];
            const existing = watched.find((w) => w.id === targetWorkspaceId);
            if (existing) {
              existing.status = "active";
              existing.name = res.workspace.name;
            } else {
              watched.push({ id: targetWorkspaceId, name: res.workspace.name, token: token, status: "active", agent_ids: [] });
            }
            freshCfg.watched_workspaces = watched;
            saveCLIConfigForProfile(parentOpts.profile, freshCfg);
          } catch {
            // Best-effort config update
          }

          if (opts.json) return printJSON(res);

          console.log(`\nWorkspace initialized: ${res.studio.name || res.workspace.name}`);
          console.log("Agents created:");
          for (const agent of res.agents) {
            const email = agent.email_handle ? toAlookAddress(agent.email_handle) : "no email";
            console.log(`  - ${agent.name} (${email})`);
          }
          console.log(`\n  Open: ${serverUrl}/w/${res.workspace.slug}`);
        } catch (err) {
          console.error(`Error: failed to create workspace: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
        return;
      }

      // Existing path: workspace was resolved from config/env
      let targetClient = new APIClient(serverUrl, token, targetWorkspaceId);

      // Get runtimes for this workspace
      let runtimes: RuntimeResponse[];
      try {
        runtimes = await targetClient.getJSON<RuntimeResponse[]>("/api/runtimes");
      } catch (err) {
        console.error(`Error: failed to fetch runtimes: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }

      if (runtimes.length === 0) {
        console.error(`Error: No daemon registered. Run '${cmdPrefix()} daemon start' first.`);
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
      try {
        const agents = await targetClient.getJSON<Array<{ id: string }>>(`/api/agents?workspace_id=${targetWorkspaceId}`);
        if (agents.length > 0) {
          console.log("Current workspace has existing agents. Creating a new workspace...");
          const wsName = opts.name || config.name || "New Workspace";
          const newWs = await targetClient.postJSON<{ id: string; name: string }>("/api/workspaces", { name: wsName, slug: slugify(wsName) });
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
          const email = agent.email_handle ? toAlookAddress(agent.email_handle) : "no email";
          console.log(`  - ${agent.name} (${email})`);
        }
        console.log(`\n  Open: ${serverUrl}/w/${res.workspace.slug}`);
      } catch (err) {
        console.error(`Error: failed to create workspace: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  return cmd;
}
