import { Command } from "commander";
import { readFileSync } from "fs";
import { basename } from "path";
import { APIClient } from "../lib/client.js";
import { printJSON } from "../lib/output.js";
import { resolveAgentId } from "../lib/flags.js";
import { resolveClientOpts } from "../lib/resolve-client.js";
import { guessContentType } from "../lib/file-utils.js";

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
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { agentId });
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
