import { Command } from "commander";
import { writeFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import PostalMime from "postal-mime";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { printJSON, printTable } from "../lib/output.js";
import { cmdPrefix } from "../lib/env.js";
import { tempDir } from "../lib/platform.js";
import { createLogger } from "../lib/logger.js";
import { resolveAgentId } from "../lib/flags.js";

const log = createLogger({ module: "email" });

interface EmailResponse {
  id: string;
  agent_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  r2_key: string;
  is_whitelisted: boolean;
  forwarded: boolean;
  message_id: string;
  in_reply_to: string;
  references: string;
  html_body: string;
  attachments: unknown[];
  status: string;
  created_at: string;
}

const VALID_STATUSES = ["unread", "read", "archived", "sent"];
const VALID_FOLDERS = ["inbox", "sent", "untrust"];
const EMAIL_BASE = tempDir("alook-emails");

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".zip": "application/zip",
};

function guessContentType(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = filename.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function collectRepeated(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

interface AttachmentDescriptor {
  key: string;
  filename: string;
  size: number;
  contentType: string;
}

interface SendResponse {
  id: string;
  to_email: string;
}

interface WhitelistEntry {
  id: string;
  email: string;
  created_at: string;
}

function resolveClientOpts(command: Command, opts: { workspace?: string; agentId?: string }) {
  let root = command;
  while (root.parent) root = root.parent;
  const parentOpts = root.opts() || {};
  const profile: string | undefined = parentOpts.profile;
  const cfg = loadCLIConfigForProfile(profile);
  const serverUrl = parentOpts.server || cfg.server_url;
  const workspaces = cfg.watched_workspaces || [];

  // Resolve workspace: explicit flag > lookup by agent_id > single workspace
  let ws;
  if (opts.workspace) {
    ws = workspaces.find((w) => w.id === opts.workspace);
    if (!ws) {
      console.error(`Error: workspace ${opts.workspace} not found in config.`);
      process.exit(1);
    }
  } else if (opts.agentId) {
    ws = workspaces.find((w) => w.agent_ids?.includes(opts.agentId!));
    if (!ws) {
      if (workspaces.length === 1) {
        ws = workspaces[0];
      } else {
        console.error(
          `Error: agent ${opts.agentId} not found in any registered workspace. Use --workspace to specify.`,
        );
        process.exit(1);
      }
    }
  } else if (workspaces.length === 1) {
    ws = workspaces[0];
  } else {
    console.error(
      `Error: multiple workspaces registered. Use --workspace to specify which one.`,
    );
    process.exit(1);
  }

  const token = ws?.token;

  if (!token) {
    console.error(
      `Error: not registered. Run '${cmdPrefix()} register --token <token>' first.`,
    );
    process.exit(1);
  }

  return { serverUrl, token, cfg, profile, workspaceId: ws?.id };
}

export function emailCommand(): Command {
  const cmd = new Command("email").description("Manage agent emails");

  cmd
    .command("pull")
    .description("Download and parse emails to /tmp/alook-emails/{workspaceId}/{agentId}/")
    .option("--agent_id <id>", "Agent ID")
    .option("--status <status>", "Filter by status (unread, read, archived)")
    .option("--folder <folder>", "Email folder (inbox, sent, untrust)")
    .option("--limit <n>", "Maximum number of emails to download")
    .option("--offset <n>", "Number of emails to skip")
    .option("--workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON instead of files")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { workspace: opts.workspace, agentId });
      const client = new APIClient(serverUrl, token, workspaceId);

      if (opts.status && !VALID_STATUSES.includes(opts.status)) {
        console.error(
          `Error: invalid status "${opts.status}", must be one of: ${VALID_STATUSES.join(", ")}`,
        );
        process.exit(1);
      }

      if (opts.folder && !VALID_FOLDERS.includes(opts.folder)) {
        console.error(
          `Error: invalid folder "${opts.folder}", must be one of: ${VALID_FOLDERS.join(", ")}`,
        );
        process.exit(1);
      }

      if (opts.limit != null) {
        const n = parseInt(opts.limit, 10);
        if (isNaN(n) || n < 1 || n > 100) {
          console.error(`Error: --limit must be an integer between 1 and 100`);
          process.exit(1);
        }
      }

      if (opts.offset != null) {
        const n = parseInt(opts.offset, 10);
        if (isNaN(n) || n < 0) {
          console.error(`Error: --offset must be a non-negative integer`);
          process.exit(1);
        }
      }

      const emailDir_base = join(EMAIL_BASE, workspaceId, agentId);

      try {
        let query = `/api/email?agentId=${agentId}`;
        if (opts.status) query += `&status=${opts.status}`;
        if (opts.folder) query += `&folder=${opts.folder}`;
        if (opts.limit) query += `&limit=${opts.limit}`;
        if (opts.offset) query += `&offset=${opts.offset}`;

        const emails = await client.getJSON<EmailResponse[]>(query);

        if (!emails.length) {
          console.log("No emails found.");
          return;
        }

        if (opts.json) {
          printJSON(emails);
          return;
        }

        mkdirSync(emailDir_base, { recursive: true });

        const downloadedPaths: string[] = [];

        for (const email of emails) {
          const emailDir = join(emailDir_base, email.id);
          mkdirSync(emailDir, { recursive: true });

          // Write metadata
          const metadata = {
            id: email.id,
            from: email.from_email,
            to: email.to_email,
            subject: email.subject,
            date: email.created_at,
            status: email.status,
            message_id: email.message_id || "",
            in_reply_to: email.in_reply_to || "",
            references: email.references || "",
          };
          const metadataPath = join(emailDir, "metadata.json");
          writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          downloadedPaths.push(metadataPath);

          // Fetch and parse raw MIME
          let rawMime: string;
          try {
            rawMime = await client.getText(`/api/email/${email.id}/raw`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("404")) {
              log.warn(`email body not available for ${email.id}, skipping`);
              continue;
            }
            throw err;
          }

          const parsed = await new PostalMime().parse(rawMime);

          if (parsed.text) {
            const bodyPath = join(emailDir, "body.txt");
            writeFileSync(bodyPath, parsed.text);
            downloadedPaths.push(bodyPath);
          }

          if (parsed.html) {
            const htmlPath = join(emailDir, "body.html");
            writeFileSync(htmlPath, parsed.html);
            downloadedPaths.push(htmlPath);
          }

          if (parsed.attachments && parsed.attachments.length > 0) {
            const attDir = join(emailDir, "attachments");
            mkdirSync(attDir, { recursive: true });
            const usedFilenames = new Set<string>();

            for (let i = 0; i < parsed.attachments.length; i++) {
              const att = parsed.attachments[i];
              let filename = att.filename || `attachment-${i}.bin`;
              if (usedFilenames.has(filename)) {
                filename = `${i}-${filename}`;
              }
              usedFilenames.add(filename);
              const attPath = join(attDir, filename);
              const content = att.content;
              let buf: Buffer;
              if (typeof content === "string") {
                buf = Buffer.from(content, "base64");
              } else if (content instanceof ArrayBuffer) {
                buf = Buffer.from(new Uint8Array(content));
              } else {
                buf = Buffer.from(content as Uint8Array);
              }
              writeFileSync(attPath, buf);
              downloadedPaths.push(attPath);
            }
          }
        }

        console.log(
          `Downloaded ${emails.length} email${emails.length === 1 ? "" : "s"} to ${emailDir_base}/`,
        );
        for (const p of downloadedPaths) {
          console.log(`  ${p}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("set")
    .description("Update email status")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--email_id <id>", "Email ID")
    .requiredOption("--status <status>", "New status (unread, read, archived)")
    .option("--workspace <id>", "Workspace ID")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { workspace: opts.workspace, agentId });
      const client = new APIClient(serverUrl, token, workspaceId);

      if (!VALID_STATUSES.includes(opts.status)) {
        console.error(
          `Error: invalid status "${opts.status}", must be one of: ${VALID_STATUSES.join(", ")}`,
        );
        process.exit(1);
      }

      try {
        await client.patchJSON(`/api/email/${opts.email_id}`, {
          status: opts.status,
        });
        console.log(`Email ${opts.email_id} status set to ${opts.status}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("send")
    .description("Send an email from the agent")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--to <addr>", "Recipient email address")
    .requiredOption("--subject <s>", "Subject line")
    .requiredOption("--body-file <path>", "Path to HTML body file")
    .option("--from <addr>", "Send from a specific email address (custom mailbox)")
    .option("--in-reply-to <emailId>", "Email ID to reply to (sets threading headers)")
    .option(
      "--attachment <path>",
      "Path to a file to attach (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .option("--workspace <id>", "Workspace ID")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      let htmlBody: string;
      try {
        htmlBody = readFileSync(opts.bodyFile, "utf-8");
      } catch (err) {
        console.error(
          `Error: cannot read body file "${opts.bodyFile}": ${err instanceof Error ? err.message : err}`,
        );
        process.exit(1);
      }
      if (!htmlBody) {
        console.error(`Error: body file "${opts.bodyFile}" is empty`);
        process.exit(1);
      }

      const attachmentPaths: string[] = opts.attachment ?? [];
      const attachments: AttachmentDescriptor[] = [];

      try {
        for (const path of attachmentPaths) {
          let bytes: Buffer;
          let size: number;
          try {
            bytes = readFileSync(path);
            size = statSync(path).size;
          } catch (err) {
            console.error(
              `Error: cannot read attachment "${path}": ${err instanceof Error ? err.message : err}`,
            );
            process.exit(1);
          }
          const filename = basename(path);
          const contentType = guessContentType(filename);
          const form = new FormData();
          form.append(
            "file",
            new Blob([new Uint8Array(bytes)], { type: contentType }),
            filename,
          );
          const uploaded = await client.postMultipart<AttachmentDescriptor>(
            "/api/email/upload",
            form,
          );
          attachments.push({
            key: uploaded.key,
            filename: uploaded.filename,
            size: uploaded.size ?? size,
            contentType: uploaded.contentType ?? contentType,
          });
        }

        // Build threading context if replying
        let inReplyTo: string | undefined;
        let references: string | undefined;
        if (opts.inReplyTo) {
          try {
            const parentEmail = await client.getJSON<EmailResponse>(`/api/email/${opts.inReplyTo}`);
            if (parentEmail.message_id) {
              inReplyTo = parentEmail.message_id;
              references = [parentEmail.references, parentEmail.message_id].filter(Boolean).join(" ").trim() || undefined;
            }
          } catch {
            log.warn(`could not fetch parent email ${opts.inReplyTo}, sending without threading`);
          }
        }

        const conversationId = process.env.ALOOK_CONVERSATION_ID;
        const traceId = process.env.ALOOK_TRACE_ID;
        const sourceTaskId = process.env.ALOOK_TASK_ID;
        const res = await client.postJSON<SendResponse>("/api/email/send", {
          agentId,
          to: opts.to,
          subject: opts.subject,
          htmlBody,
          attachments,
          ...(inReplyTo ? { inReplyTo, references } : {}),
          ...(opts.from ? { from: opts.from } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(traceId ? { traceId } : {}),
          ...(sourceTaskId ? { sourceTaskId } : {}),
        });
        console.log(`Sent email to ${res.to_email} (id: ${res.id})`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("forward")
    .description("Forward an email to a new recipient")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--email_id <id>", "Source email ID to forward")
    .requiredOption("--to <addr>", "Recipient email address")
    .option("--from <addr>", "Send from a specific email address (custom mailbox)")
    .option("--note <text>", "Text to prepend above the forwarded message")
    .option(
      "--attachment <path>",
      "Extra file to attach (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .option("--workspace <id>", "Workspace ID")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        // 1. Fetch original email metadata
        let original: EmailResponse;
        try {
          original = await client.getJSON<EmailResponse>(`/api/email/${opts.email_id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            console.error(`Error: email ${opts.email_id} not found`);
            process.exit(1);
          }
          throw err;
        }

        // 2. Fetch raw MIME
        let rawMime: string;
        try {
          rawMime = await client.getText(`/api/email/${opts.email_id}/raw`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            console.error(`Error: raw email body not available for ${opts.email_id}`);
            process.exit(1);
          }
          throw err;
        }

        // 3. Parse MIME to extract body and attachments
        const parsed = await new PostalMime().parse(rawMime);

        // 4. Re-upload original attachments
        const attachments: AttachmentDescriptor[] = [];
        if (parsed.attachments && parsed.attachments.length > 0) {
          for (const att of parsed.attachments) {
            const filename = att.filename || "attachment.bin";
            const contentType = att.mimeType || "application/octet-stream";
            const content = att.content;
            let buf: Buffer;
            if (typeof content === "string") {
              buf = Buffer.from(content, "base64");
            } else if (content instanceof ArrayBuffer) {
              buf = Buffer.from(new Uint8Array(content));
            } else {
              buf = Buffer.from(content as Uint8Array);
            }
            const form = new FormData();
            form.append(
              "file",
              new Blob([new Uint8Array(buf)], { type: contentType }),
              filename,
            );
            const uploaded = await client.postMultipart<AttachmentDescriptor>(
              "/api/email/upload",
              form,
            );
            attachments.push({
              key: uploaded.key,
              filename: uploaded.filename,
              size: uploaded.size ?? buf.byteLength,
              contentType: uploaded.contentType ?? contentType,
            });
          }
        }

        // 5. Upload extra --attachment files
        const extraPaths: string[] = opts.attachment ?? [];
        for (const path of extraPaths) {
          let bytes: Buffer;
          let size: number;
          try {
            bytes = readFileSync(path);
            size = statSync(path).size;
          } catch (err) {
            console.error(
              `Error: cannot read attachment "${path}": ${err instanceof Error ? err.message : err}`,
            );
            process.exit(1);
          }
          const filename = basename(path);
          const contentType = guessContentType(filename);
          const form = new FormData();
          form.append(
            "file",
            new Blob([new Uint8Array(bytes)], { type: contentType }),
            filename,
          );
          const uploaded = await client.postMultipart<AttachmentDescriptor>(
            "/api/email/upload",
            form,
          );
          attachments.push({
            key: uploaded.key,
            filename: uploaded.filename,
            size: uploaded.size ?? size,
            contentType: uploaded.contentType ?? contentType,
          });
        }

        // 6. Compose forwarded HTML body
        let htmlBody = "";
        if (opts.note) {
          htmlBody += `<p>${opts.note}</p>`;
        }
        htmlBody += `<br><br>---------- Forwarded message ----------<br>`;
        htmlBody += `From: ${original.from_email}<br>`;
        htmlBody += `Date: ${original.created_at}<br>`;
        htmlBody += `Subject: ${original.subject}<br>`;
        htmlBody += `To: ${original.to_email}<br><br>`;
        if (parsed.html) {
          htmlBody += parsed.html;
        } else if (parsed.text) {
          htmlBody += `<pre>${parsed.text}</pre>`;
        }

        // 7. Build subject
        const subject = /^fwd:/i.test(original.subject)
          ? original.subject
          : `Fwd: ${original.subject}`;

        // 8. Send
        const conversationId = process.env.ALOOK_CONVERSATION_ID;
        const traceId = process.env.ALOOK_TRACE_ID;
        const sourceTaskId = process.env.ALOOK_TASK_ID;
        const res = await client.postJSON<SendResponse>("/api/email/send", {
          agentId,
          to: opts.to,
          subject,
          htmlBody,
          attachments,
          ...(opts.from ? { from: opts.from } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(traceId ? { traceId } : {}),
          ...(sourceTaskId ? { sourceTaskId } : {}),
        });
        console.log(`Forwarded email to ${res.to_email} (id: ${res.id})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "__exit__") throw err;
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  const whitelistCmd = new Command("whitelist").description(
    "Manage email whitelist (allowed senders)",
  );

  whitelistCmd
    .command("list")
    .description("List all whitelisted emails for an agent")
    .option("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const entries = await client.getJSON<WhitelistEntry[]>(
          `/api/agents/${agentId}/whitelist`,
        );

        if (!entries.length) {
          console.log("No whitelisted emails.");
          return;
        }

        if (opts.json) {
          printJSON(entries);
          return;
        }

        printTable(
          ["ID", "EMAIL", "CREATED AT"],
          entries.map((e) => [e.id, e.email, e.created_at]),
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  whitelistCmd
    .command("add")
    .description("Add an email to the whitelist")
    .option("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .argument("<email>", "Email address to whitelist")
    .action(async (email, opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const entry = await client.postJSON<WhitelistEntry>(
          `/api/agents/${agentId}/whitelist`,
          { email: email.toLowerCase() },
        );
        console.log(`Added ${entry.email} to whitelist (id: ${entry.id})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409")) {
          console.error(`Error: ${email.toLowerCase()} is already whitelisted`);
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
    });

  whitelistCmd
    .command("delete")
    .description("Remove an email from the whitelist")
    .option("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .argument("<email>", "Email address to remove")
    .action(async (email, opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId,
      });
      const client = new APIClient(serverUrl, token, workspaceId);
      const normalizedEmail = email.toLowerCase();

      try {
        const entries = await client.getJSON<WhitelistEntry[]>(
          `/api/agents/${agentId}/whitelist`,
        );
        const entry = entries.find((e) => e.email === normalizedEmail);

        if (!entry) {
          console.error(`Error: ${normalizedEmail} is not in the whitelist`);
          process.exit(1);
        }

        await client.deleteJSON(
          `/api/agents/${agentId}/whitelist/${entry.id}`,
        );
        console.log(`Removed ${normalizedEmail} from whitelist`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "__exit__") throw err;
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd.addCommand(whitelistCmd);

  return cmd;
}
