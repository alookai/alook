import { Command } from "commander";
import { readFileSync } from "fs";
import { basename } from "path";
import { APIClient } from "../lib/client.js";
import { printJSON } from "../lib/output.js";
import { resolveAgentId } from "../lib/flags.js";
import { resolveClientOpts } from "../lib/resolve-client.js";
import { guessContentType } from "../lib/file-utils.js";

export function syncCommand(): Command {
  const cmd = new Command("sync").description("Sync info with the user (files, messages)");

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

      let thumbnailBytes: Buffer | null = null;
      const isRasterImage = contentType.startsWith("image/") && contentType !== "image/svg+xml";
      if (isRasterImage) {
        try {
          const sharpMod = await import("sharp");
          const sharp = sharpMod.default;
          thumbnailBytes = await sharp(bytes)
            .resize(200, 200, { fit: "inside" })
            .jpeg({ quality: 70 })
            .toBuffer();
        } catch (err) {
          console.error(`Warning: thumbnail generation skipped: ${(err as Error).message}`);
        }
      }

      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: contentType }),
        filename
      );
      if (thumbnailBytes) {
        form.append(
          "thumbnail",
          new Blob([new Uint8Array(thumbnailBytes)], { type: "image/jpeg" }),
          `thumb_${filename}.jpg`
        );
      }
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

  cmd
    .command("send-dm")
    .description("Send a message to the user in the current conversation (the agent's voice)")
    .option("--agent_id <id>", "Agent ID")
    .option("--conversation_id <id>", "Conversation ID (defaults to $ALOOK_CONVERSATION_ID)")
    .option("--message <text>", "Message body")
    .option("--message-file <path>", "Read message body from a file")
    .action(async (opts, command) => {
      if (opts.message && opts.messageFile) {
        console.error("Error: --message and --message-file are mutually exclusive");
        process.exit(1);
      }

      let content: string;
      if (opts.messageFile) {
        try {
          content = readFileSync(opts.messageFile, "utf-8");
        } catch (err) {
          console.error(`Error: cannot read file "${opts.messageFile}": ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        content = (opts.message ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      }
      if (!content.trim()) {
        console.error("Error: --message or --message-file is required (and must not be empty)");
        process.exit(1);
      }

      const conversationId = opts.conversation_id || process.env.ALOOK_CONVERSATION_ID;
      if (!conversationId) {
        console.error("Error: no conversation id (set --conversation_id or $ALOOK_CONVERSATION_ID)");
        process.exit(1);
      }

      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { agentId });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const result = await client.postJSON<Record<string, unknown>>(
          `/api/daemon/conversations/${encodeURIComponent(conversationId)}/messages`,
          { content, task_id: process.env.ALOOK_TASK_ID || undefined }
        );
        printJSON(result);
      } catch (err) {
        console.error(`Error sending message: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
