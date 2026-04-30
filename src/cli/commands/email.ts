import { Command } from "commander";
import { writeFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import PostalMime from "postal-mime";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { printJSON, printTable } from "../lib/output.js";
import { cmdPrefix } from "../lib/env.js";

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

const VALID_STATUSES = ["unread", "read", "archived"];
const EMAIL_BASE = "/tmp/alook-emails";

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
    .requiredOption("--agent_id <id>", "Agent ID")
    .option("--status <status>", "Filter by status (unread, read, archived)")
    .option("--workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON instead of files")
    .action(async (opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { workspace: opts.workspace, agentId: opts.agent_id });
      const client = new APIClient(serverUrl, token, workspaceId);

      if (opts.status && !VALID_STATUSES.includes(opts.status)) {
        console.error(
          `Error: invalid status "${opts.status}", must be one of: ${VALID_STATUSES.join(", ")}`,
        );
        process.exit(1);
      }

      const emailDir_base = join(EMAIL_BASE, workspaceId, opts.agent_id);

      try {
        let query = `/api/email?agentId=${opts.agent_id}`;
        if (opts.status) query += `&status=${opts.status}`;

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
              console.warn(
                `Warning: email body not available for ${email.id}, skipping`,
              );
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
    .requiredOption("--agent_id <id>", "Agent ID")
    .requiredOption("--email_id <id>", "Email ID")
    .requiredOption("--status <status>", "New status (unread, read, archived)")
    .option("--workspace <id>", "Workspace ID")
    .action(async (opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, { workspace: opts.workspace, agentId: opts.agent_id });
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
    .requiredOption("--agent_id <id>", "Agent ID")
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
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId: opts.agent_id,
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
            console.warn(`Warning: could not fetch parent email ${opts.inReplyTo}, sending without threading`);
          }
        }

        const conversationId = process.env.ALOOK_CONVERSATION_ID;
        const res = await client.postJSON<SendResponse>("/api/email/send", {
          agentId: opts.agent_id,
          to: opts.to,
          subject: opts.subject,
          htmlBody,
          attachments,
          ...(inReplyTo ? { inReplyTo, references } : {}),
          ...(opts.from ? { from: opts.from } : {}),
          ...(conversationId ? { conversationId } : {}),
        });
        console.log(`Sent email to ${res.to_email} (id: ${res.id})`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  const whitelistCmd = new Command("whitelist").description(
    "Manage email whitelist (allowed senders)",
  );

  whitelistCmd
    .command("list")
    .description("List all whitelisted emails for an agent")
    .requiredOption("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId: opts.agent_id,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const entries = await client.getJSON<WhitelistEntry[]>(
          `/api/agents/${opts.agent_id}/whitelist`,
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
    .requiredOption("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .argument("<email>", "Email address to whitelist")
    .action(async (email, opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId: opts.agent_id,
      });
      const client = new APIClient(serverUrl, token, workspaceId);

      try {
        const entry = await client.postJSON<WhitelistEntry>(
          `/api/agents/${opts.agent_id}/whitelist`,
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
    .requiredOption("--agent_id <id>", "Agent ID")
    .option("--workspace <id>", "Workspace ID")
    .argument("<email>", "Email address to remove")
    .action(async (email, opts, command) => {
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, {
        workspace: opts.workspace,
        agentId: opts.agent_id,
      });
      const client = new APIClient(serverUrl, token, workspaceId);
      const normalizedEmail = email.toLowerCase();

      try {
        const entries = await client.getJSON<WhitelistEntry[]>(
          `/api/agents/${opts.agent_id}/whitelist`,
        );
        const entry = entries.find((e) => e.email === normalizedEmail);

        if (!entry) {
          console.error(`Error: ${normalizedEmail} is not in the whitelist`);
          process.exit(1);
        }

        await client.deleteJSON(
          `/api/agents/${opts.agent_id}/whitelist/${entry.id}`,
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
