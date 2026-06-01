import { Command } from "commander";
import { readFileSync } from "fs";
import { APIClient } from "../lib/client.js";
import { printJSON } from "../lib/output.js";
import { resolveAgentId } from "../lib/flags.js";
import { resolveClientOpts } from "../lib/resolve-client.js";
import { gatherContextEnvVars } from "../lib/context-env.js";

function readField(opts: { inline?: string; file?: string }, inlineName: string, fileName: string): string | null {
  if (opts.inline && opts.file) {
    console.error(`Error: --${inlineName} and --${fileName} are mutually exclusive`);
    process.exit(1);
  }
  if (opts.file) return readFileSync(opts.file, "utf-8");
  return opts.inline ?? null;
}

export function agentCommand(): Command {
  const cmd = new Command("agent").description("Manage agents");

  cmd
    .command("recruit")
    .description("Recruit a new colleague agent")
    .option("--agent_id <id>", "Agent ID (or set ALOOK_AGENT_ID env var)")
    .option("--instructions <text>", "Instructions for the new agent (system prompt)")
    .option("--instructions-file <path>", "Read instructions from a file")
    .option("--relationship <text>", "Relationship/delegation instruction for the link")
    .option("--relationship-file <path>", "Read relationship from a file")
    .option("--name <name>", "Preferred name for the new agent (auto-generated if omitted)")
    .option("--description <text>", "Agent description")
    .option("--model <model>", "Model override")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const instructions = readField(
        { inline: opts.instructions, file: opts.instructionsFile },
        "instructions",
        "instructions-file",
      );
      if (!instructions) {
        console.error("Error: --instructions or --instructions-file is required");
        process.exit(1);
      }

      const relationship = readField(
        { inline: opts.relationship, file: opts.relationshipFile },
        "relationship",
        "relationship-file",
      );
      if (!relationship) {
        console.error("Error: --relationship or --relationship-file is required");
        process.exit(1);
      }

      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { agentId });
      const client = new APIClient(serverUrl, token, workspaceId);

      const ctx = gatherContextEnvVars();
      const body: Record<string, string> = { instructions, relationship };
      if (opts.name) body.name = opts.name;
      if (opts.description) body.description = opts.description;
      if (opts.model) body.model = opts.model;
      if (ctx.conversationId) body.context_key = ctx.conversationId;

      try {
        const res = await client.postJSON<{
          agent: { id: string; name: string; email: string };
          link: { id: string; instruction: string };
        }>(`/api/agents/recruit?agentId=${encodeURIComponent(agentId)}`, body);

        if (opts.json) return printJSON(res);
        console.log(`Recruited ${res.agent.name} (${res.agent.email}) — ${res.agent.id}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("link")
    .description("Set (create-or-replace) the relationship with an existing colleague agent")
    .option("--agent_id <id>", "Calling agent ID (or set ALOOK_AGENT_ID env var)")
    .option("--to <handleOrId>", "Target agent: email handle (coder / coder@alook.ai) or agent id (ag_...)")
    .option("--relationship <text>", "Relationship/delegation instruction for the link")
    .option("--relationship-file <path>", "Read relationship from a file")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const relationship = readField(
        { inline: opts.relationship, file: opts.relationshipFile },
        "relationship",
        "relationship-file",
      );
      if (!relationship) {
        console.error("Error: --relationship or --relationship-file is required");
        process.exit(1);
      }

      const to = opts.to as string | undefined;
      if (!to) {
        console.error("Error: --to <handleOrId> is required");
        process.exit(1);
      }

      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { agentId });
      const client = new APIClient(serverUrl, token, workspaceId);

      type AgentInfo = { id: string; name: string; email_handle: string | null };

      try {
        // Resolve target to an agent id. ag_-prefixed values are ids; anything
        // else is treated as an email handle (domain stripped) and resolved via
        // GET /api/agents, which returns id + email_handle for each agent.
        let targetAgentId: string;
        let agents: AgentInfo[] | null = null;
        if (to.startsWith("ag_")) {
          targetAgentId = to;
        } else {
          const handle = to.split("@")[0].toLowerCase();
          agents = await client.getJSON<AgentInfo[]>("/api/agents");
          const match = agents.find((a) => (a.email_handle || "").toLowerCase() === handle);
          if (!match) {
            console.error(`Error: no agent with handle '${handle}' in this workspace`);
            process.exit(1);
          }
          targetAgentId = match.id;
        }

        const res = await client.putJSON<{
          id: string;
          source_agent_id: string;
          target_agent_id: string;
          instruction: string;
          created: boolean;
        }>(`/api/agent-links?agentId=${encodeURIComponent(agentId)}`, {
          target_agent_id: targetAgentId,
          instruction: relationship,
        });

        if (opts.json) return printJSON(res);

        // Best-effort friendly labels; fall back to ids if names aren't handy.
        if (!agents) {
          try {
            agents = await client.getJSON<AgentInfo[]>("/api/agents");
          } catch {
            agents = [];
          }
        }
        const label = (id: string) => agents!.find((a) => a.id === id)?.name || id;
        const meLabel = label(agentId);
        const targetLabel = label(targetAgentId);
        console.log(`Linked ${meLabel} <-> ${targetLabel} (${res.created ? "created" : "updated"})`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  return cmd;
}
