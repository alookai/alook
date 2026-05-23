import { Command } from "commander";
import { readFileSync } from "fs";
import { APIClient } from "../lib/client.js";
import { loadCLIConfigForProfile } from "../lib/config.js";
import { printJSON } from "../lib/output.js";
import { cmdPrefix } from "../lib/env.js";
import { resolveAgentId } from "../lib/flags.js";

const VALID_STATUSES = ["todo", "in_progress", "review", "done", "closed", "canceled", "failed"];

interface IssueResponse {
  id: string;
  workspace_id: string;
  agent_id: string;
  creator_user_id: string;
  conversation_id: string;
  latest_task_id: string | null;
  title: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface MessageResponse {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface CommentResponse {
  id: string;
  author_type: string;
  author_id: string;
  content: string;
  created_at: string;
}

function resolveClientOpts(command: Command, agentId: string) {
  let root = command;
  while (root.parent) root = root.parent;
  const parentOpts = root.opts() || {};
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

function readBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body && opts.bodyFile) {
    console.error("Error: --body and --body-file are mutually exclusive");
    process.exit(1);
  }
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf-8");
  return opts.body ?? "";
}

function printIssue(issue: IssueResponse): void {
  console.log(`${issue.id}  ${issue.status.padEnd(11)}  ${issue.title}`);
}

function printIssueDetail(issue: IssueResponse, messages?: MessageResponse[], comments?: CommentResponse[]): void {
  console.log(`id:              ${issue.id}`);
  console.log(`agent_id:        ${issue.agent_id}`);
  console.log(`status:          ${issue.status}`);
  console.log(`conversation_id: ${issue.conversation_id}`);
  if (issue.latest_task_id) console.log(`latest_task_id:  ${issue.latest_task_id}`);
  console.log(`title:           ${issue.title}`);
  console.log("description:");
  console.log(issue.description || "(no description)");
  const events = messages?.filter((m) => m.role === "event") ?? [];
  if (events.length > 0) {
    console.log("\nevents:");
    for (const m of events) {
      console.log(`  [${m.created_at}] ${m.content}`);
    }
  }
  if (comments && comments.length > 0) {
    console.log("\ncomments:");
    for (const c of comments) {
      console.log(`  [${c.created_at}] (${c.author_type}) ${c.content}`);
    }
  }
}

export function issueCommand(): Command {
  const cmd = new Command("issue").description("Manage assigned issues");

  cmd
    .command("create")
    .description("Create and dispatch an issue to an agent")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--title <title>", "Issue title")
    .option("--description <text>", "Issue description")
    .option("--body-file <path>", "Read issue description from a file")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);
      const description = readBody({ body: opts.description, bodyFile: opts.bodyFile });
      try {
        const res = await client.postJSON<{ issue: IssueResponse }>("/api/issues", {
          agent_id: agentId,
          title: opts.title,
          description,
        });
        if (opts.json) return printJSON(res);
        console.log(`Created ${res.issue.id} — ${res.issue.title}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List issues for an agent")
    .option("--agent_id <id>", "Agent ID")
    .option("--status <status>", `Filter by status (${VALID_STATUSES.join(", ")})`)
    .option("--completed", "Show completed/closed/canceled/failed issues")
    .option("--all", "Show all issues")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      if (opts.status && !VALID_STATUSES.includes(opts.status)) {
        console.error(`Error: invalid status "${opts.status}"`);
        process.exit(1);
      }
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);
      const params = new URLSearchParams({ agentId });
      if (opts.status) params.set("status", opts.status);
      if (!opts.all && !opts.status) params.set("terminal", opts.completed ? "true" : "false");
      try {
        const issues = await client.getJSON<IssueResponse[]>(`/api/issues?${params}`);
        if (opts.json) return printJSON(issues);
        if (issues.length === 0) {
          console.log("No issues found.");
          return;
        }
        for (const issue of issues) printIssue(issue);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("show")
    .description("Show issue details and conversation")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--issue_id <id>", "Issue ID")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);
      try {
        const res = await client.getJSON<{ issue: IssueResponse; messages: MessageResponse[]; comments: CommentResponse[] }>(`/api/issues/${opts.issue_id}?agentId=${encodeURIComponent(agentId)}`);
        if (res.issue.agent_id !== agentId) {
          console.error(`Error: issue ${res.issue.id} does not belong to agent ${agentId}`);
          process.exit(1);
        }
        if (opts.json) return printJSON(res);
        printIssueDetail(res.issue, res.messages, res.comments);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Update issue status or text")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--issue_id <id>", "Issue ID")
    .option("--status <status>", `New status (${VALID_STATUSES.join(", ")})`)
    .option("--title <title>", "New title")
    .option("--description <text>", "New description")
    .option("--body-file <path>", "Read description from a file")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      if (opts.status && !VALID_STATUSES.includes(opts.status)) {
        console.error(`Error: invalid status "${opts.status}"`);
        process.exit(1);
      }
      const description = readBody({ body: opts.description, bodyFile: opts.bodyFile });
      const body: Record<string, string> = {};
      if (opts.status) body.status = opts.status;
      if (opts.title) body.title = opts.title;
      if (description) body.description = description;
      if (Object.keys(body).length === 0) {
        console.error("Error: pass at least one of --status, --title, --description, --body-file");
        process.exit(1);
      }
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);
      try {
        const issue = await client.patchJSON<IssueResponse>(`/api/issues/${opts.issue_id}?agentId=${encodeURIComponent(agentId)}`, body);
        if (opts.json) return printJSON(issue);
        printIssue(issue);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  cmd
    .command("comment")
    .description("Append a comment to an issue")
    .option("--agent_id <id>", "Agent ID")
    .requiredOption("--issue_id <id>", "Issue ID")
    .option("--body <text>", "Comment text")
    .option("--body-file <path>", "Read comment from a file")
    .option("--json", "Output as JSON")
    .action(async (opts, command) => {
      const content = readBody({ body: opts.body, bodyFile: opts.bodyFile }).trim();
      if (!content) {
        console.error("Error: pass --body or --body-file");
        process.exit(1);
      }
      const agentId = resolveAgentId(opts);
      const { serverUrl, token, workspaceId } = resolveClientOpts(command, agentId);
      const client = new APIClient(serverUrl, token, workspaceId);
      try {
        const res = await client.postJSON<{ comment: CommentResponse }>(`/api/issues/${opts.issue_id}/comments?agentId=${encodeURIComponent(agentId)}`, { content });
        if (opts.json) return printJSON(res);
        console.log(`Commented on ${opts.issue_id}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  return cmd;
}
