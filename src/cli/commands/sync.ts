import { Command } from "commander";
import { readFileSync } from "fs";
import { basename } from "path";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { printJSON } from "../lib/output.js";
import { cmdPrefix } from "../lib/env.js";
import { resolveAgentId } from "../lib/flags.js";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

function guessContentType(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = filename.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function resolveClientOpts(command: Command, agentId: string) {
  const parentOpts = command.parent?.parent?.opts() || {};
  const profile: string | undefined = parentOpts.profile;
  const cfg = loadCLIConfigForProfile(profile);
  const serverUrl = parentOpts.server || cfg.server_url;
  const workspaces = cfg.watched_workspaces || [];

  const ws = workspaces.find((w) => w.agent_ids?.includes(agentId));
  if (!ws || !ws.token) {
    console.error(
      `Error: no registered workspace contains agent ${agentId}. Run '${cmdPrefix()} register --token <token>' first.`
    );
    process.exit(1);
  }
  return { serverUrl, token: ws.token, workspaceId: ws.id };
}

export function syncCommand(): Command {
  const cmd = new Command("sync").description("File sync utilities");

  cmd
    .command("upload-artifact")
    .description("Upload a file artifact to a conversation")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--conversation_id <id>", "Conversation ID")
    .requiredOption("--file <path>", "Path to file to upload")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);

      let bytes: Buffer;
      try {
        bytes = readFileSync(opts.file);
      } catch (err) {
        console.error(`Error: cannot read file "${opts.file}": ${(err as Error).message}`);
        process.exit(1);
      }

      const filename = basename(opts.file);
      const contentType = guessContentType(filename);

      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: contentType }),
        filename
      );
      form.append("agent_id", agentId);
      form.append("conversation_id", opts.conversation_id);

      try {
        const result = await client.postMultipart<Record<string, unknown>>(
          "/api/artifacts/upload",
          form
        );
        printJSON(result);
      } catch (err) {
        console.error(`Error uploading artifact: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
