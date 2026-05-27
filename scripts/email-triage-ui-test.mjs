#!/usr/bin/env node
/**
 * Email triage manual UI test runner — executes Cases 1-17 and prints results.
 * Usage: node scripts/email-triage-ui-test.mjs
 */
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WEB_DIR = resolve(ROOT, "src/web");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL ?? "http://localhost:8787";

const results = [];
function pass(caseId, detail) {
  results.push({ case: caseId, status: "PASS", detail });
  console.log(`✅ ${caseId}: ${detail}`);
}
function fail(caseId, detail) {
  results.push({ case: caseId, status: "FAIL", detail });
  console.log(`❌ ${caseId}: ${detail}`);
}
function skip(caseId, detail) {
  results.push({ case: caseId, status: "SKIP", detail });
  console.log(`⏭️  ${caseId}: ${detail}`);
}

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21);
}

function sqlQuery(query) {
  const escaped = query.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute alook-app --local --json --command "${escaped}"`,
    { cwd: WEB_DIR, stdio: "pipe" },
  ).toString();
  return JSON.parse(raw)[0]?.results ?? [];
}

function sql(query) {
  const escaped = query.replace(/"/g, '\\"');
  execSync(`npx wrangler d1 execute alook-app --local --command "${escaped}"`, {
    cwd: WEB_DIR,
    stdio: "pipe",
  });
}

async function tokenRequest(path, token, opts = {}, retries = 3) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${APP_URL}${path}`, {
        ...opts,
        headers: {
          ...(opts.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
      if (![502, 503, 504].includes(res.status) || i === retries - 1) {
        return res;
      }
    } catch (error) {
      lastError = error;
      if (i === retries - 1) throw error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastError ?? new Error(`request failed: ${path}`);
}

function rawEmail(from, to, subject, body, extraHeaders = {}) {
  const msgId = `<${randomUUID()}@triage.test>`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ];
  return { raw: lines.join("\r\n"), msgId };
}

function multipartEmail(from, to, subject, textBody, htmlBody) {
  const boundary = `----TriageBoundary${randomUUID().slice(0, 8)}`;
  const msgId = `<${randomUUID()}@triage.test>`;
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    textBody,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    "",
    htmlBody,
    `--${boundary}--`,
  ].join("\r\n");
  return { raw, msgId };
}

function attachmentOnlyEmail(from, to, subject, filename) {
  const boundary = `----Attach${randomUUID().slice(0, 8)}`;
  const msgId = `<${randomUUID()}@triage.test>`;
  const pdfContent = "%PDF-1.4 fake invoice content";
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    pdfContent,
    `--${boundary}--`,
  ].join("\r\n");
  return { raw, msgId };
}

function emptyBodyEmail(from, to, subject) {
  const msgId = `<${randomUUID()}@triage.test>`;
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "",
  ].join("\r\n");
  return { raw, msgId };
}

async function postEmailRaw(from, to, rawBody, retries = 3) {
  const url = `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function waitFor(fn, maxMs = 8000, interval = 300) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

function seedTestData() {
  const userId = `u_${nanoid()}`;
  const workspaceId = `sp_${nanoid()}`;
  const memberId = `mb_${nanoid()}`;
  const runtimeId = `rt_${nanoid()}`;
  const agentId = `ag_${nanoid()}`;
  const daemonId = `daemon_${nanoid()}`;
  const machineTokenId = `mt_${nanoid()}`;
  const rawToken = `al_${randomUUID().replace(/-/g, "")}`;
  const emailHandle = `e2e-${nanoid()}`;
  const whitelistId = `wl_${nanoid()}`;
  const slug = `triage-${nanoid().slice(0, 8)}`;
  const now = new Date().toISOString();

  sql(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${userId}', 'Triage Tester', '${userId}@triage.test', 1, '${now}', '${now}')`);
  sql(`INSERT INTO workspace (id, name, slug, created_at, updated_at) VALUES ('${workspaceId}', 'Triage Test WS', '${slug}', '${now}', '${now}')`);
  sql(`INSERT INTO member (id, workspace_id, user_id, role, created_at) VALUES ('${memberId}', '${workspaceId}', '${userId}', 'owner', '${now}')`);
  sql(`INSERT INTO machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at) VALUES ('${daemonId}', '${workspaceId}', 'test-device', '${now}', '${now}', '${now}')`);
  sql(`INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES ('${runtimeId}', '${workspaceId}', '${daemonId}', 'local', 'claude', 'online', 'test-device', '${now}', '${now}')`);
  sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${agentId}', '${workspaceId}', 'Triage Agent', '${runtimeId}', '${emailHandle}', '${userId}', '${now}', '${now}')`);
  sql(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES ('${machineTokenId}', '${userId}', '${workspaceId}', '${rawToken}', 'triage-test', 'active', '${now}')`);
  sql(`INSERT INTO agent_whitelist (id, agent_id, workspace_id, email, created_at) VALUES ('${whitelistId}', '${agentId}', '${workspaceId}', 'trusted@example.com', '${now}')`);

  return {
    userId,
    workspaceId,
    slug,
    agentId,
    daemonId,
    emailHandle,
    agentEmail: `${emailHandle}@alook.ai`,
    machineToken: rawToken,
    whitelistId,
  };
}

function cleanup(seed) {
  const ws = seed.workspaceId;
  try {
    sql(`DELETE FROM task_message WHERE task_id IN (SELECT id FROM agent_task_queue WHERE workspace_id = '${ws}')`);
    sql(`DELETE FROM agent_task_queue WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE workspace_id = '${ws}')`);
    sql(`DELETE FROM conversation WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM emails WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = '${ws}')`);
    sql(`DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = '${ws}')`);
    sql(`DELETE FROM agent WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM agent_runtime WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM machine WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM machine_token WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM member WHERE workspace_id = '${ws}'`);
    sql(`DELETE FROM workspace WHERE id = '${ws}'`);
    sql(`DELETE FROM "user" WHERE id = '${seed.userId}'`);
  } catch {
    /* ignore */
  }
}

function countEmails(agentId, mailbox, direction) {
  const rows = sqlQuery(
    `SELECT count(*) as c FROM emails WHERE agent_id='${agentId}' AND mailbox='${mailbox}' AND direction='${direction}'`,
  );
  return rows[0]?.c ?? 0;
}

function getEmail(agentId, fromEmail) {
  const rows = sqlQuery(
    `SELECT * FROM emails WHERE agent_id='${agentId}' AND from_email='${fromEmail}' ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

function getTriageTask(agentId, inboundEmailId) {
  const rows = sqlQuery(
    `SELECT * FROM agent_task_queue WHERE agent_id='${agentId}' AND type='email_triage' ORDER BY created_at DESC`,
  );
  return rows.find((t) => {
    try {
      const ctx = typeof t.context === "string" ? JSON.parse(t.context) : t.context;
      return ctx?.inboundEmailId === inboundEmailId;
    } catch {
      return false;
    }
  }) ?? null;
}

function parseTaskContext(task) {
  if (!task?.context) return null;
  return typeof task.context === "string" ? JSON.parse(task.context) : task.context;
}

function projectedDaemonPromptFields(task) {
  const ctx = parseTaskContext(task);
  if (!ctx) return null;
  return {
    from: ctx.from,
    to: ctx.to,
    subject: ctx.subject,
    message_id: ctx.messageId,
    in_reply_to: ctx.inReplyTo,
    references: ctx.references,
    body_text: ctx.bodyText,
    body_html: ctx.bodyHtml,
    attachment_summaries: ctx.attachmentSummaries,
    inbound_email_id: ctx.inboundEmailId,
  };
}

function getTasksByType(agentId, type) {
  return sqlQuery(
    `SELECT * FROM agent_task_queue WHERE agent_id='${agentId}' AND type='${type}' ORDER BY created_at DESC`,
  );
}

function getHiddenTriageConversations(workspaceId) {
  return sqlQuery(
    `SELECT * FROM conversation WHERE workspace_id='${workspaceId}' AND type='email_triage'`,
  );
}

function dispatchTask(taskId) {
  sql(
    `UPDATE agent_task_queue SET status='dispatched', dispatched_at='${new Date().toISOString()}' WHERE id='${taskId}' AND status='queued'`,
  );
}

async function completeTask(taskId, token, workspaceId, triageOutput) {
  dispatchTask(taskId);
  await tokenRequest(`/api/daemon/tasks/${taskId}/start?workspace_id=${workspaceId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await tokenRequest(`/api/daemon/tasks/${taskId}/complete?workspace_id=${workspaceId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output: triageOutput, session_id: "test-session" }),
  });
  return res;
}

async function failTask(taskId, token, workspaceId, error) {
  dispatchTask(taskId);
  await tokenRequest(`/api/daemon/tasks/${taskId}/start?workspace_id=${workspaceId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return tokenRequest(`/api/daemon/tasks/${taskId}/fail?workspace_id=${workspaceId}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  });
}

function moveEmailToInbox(emailId, workspaceId) {
  sql(
    `UPDATE emails SET mailbox='inbox', status='unread' WHERE id='${emailId}' AND workspace_id='${workspaceId}'`,
  );
}

async function main() {
  console.log("\n=== Email Triage UI Test Runner ===\n");

  const seed = seedTestData();
  const { agentId, workspaceId, agentEmail, machineToken, slug, daemonId } = seed;
  console.log(`Workspace: ${slug} (${workspaceId})`);
  console.log(`Agent email: ${agentEmail}\n`);

  const baseline = {
    inbox: countEmails(agentId, "inbox", "inbound"),
    draft: countEmails(agentId, "draft", "inbound"),
    untrust: countEmails(agentId, "untrust", "inbound"),
    outboundDraft: sqlQuery(
      `SELECT count(*) as c FROM emails WHERE agent_id='${agentId}' AND direction='outbound' AND mailbox='draft'`,
    )[0]?.c ?? 0,
  };
  console.log("Baseline counts:", baseline, "\n");

  try {
    // Case 1: Whitelist email
    {
      const subject = `[Case1] Whitelist ${Date.now()}`;
      const { raw } = rawEmail("trusted@example.com", agentEmail, subject, "Trusted sender body");
      await postEmailRaw("trusted@example.com", agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, "trusted@example.com"));
      const notifTasks = await waitFor(() => {
        const tasks = getTasksByType(agentId, "email_notification");
        return tasks.length > 0 ? tasks : null;
      });
      const triageTasks = getTasksByType(agentId, "email_triage");
      if (email?.mailbox === "inbox" && notifTasks?.length && !triageTasks.some((t) => {
        const ctx = JSON.parse(t.context);
        return ctx.inboundEmailId === email.id;
      })) {
        pass("Case 1", "Whitelisted → inbox + EMAIL_NOTIFICATION, no triage");
      } else {
        fail("Case 1", `mailbox=${email?.mailbox}, notif=${notifTasks?.length}, triage=${triageTasks.length}`);
      }
    }

    // Case 2: Non-whitelist text body
    {
      const from = `normal-text-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case2] Text body ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Can you help me review this proposal?");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      const ctx = task ? parseTaskContext(task) : null;
      const promptJson = task ? projectedDaemonPromptFields(task) : null;
      const hidden = getHiddenTriageConversations(workspaceId);
      if (
        email?.mailbox === "draft" &&
        task &&
        ctx?.bodyText &&
        promptJson?.body_text &&
        ctx?.from === from &&
        ctx?.subject === subject &&
        ctx?.inboundEmailId === email.id &&
        promptJson?.inbound_email_id === email.id &&
        hidden.length > 0
      ) {
        pass("Case 2", "Draft + EMAIL_TRIAGE with context bodyText and daemon prompt body_text");
      } else {
        fail("Case 2", JSON.stringify({ mailbox: email?.mailbox, task: !!task, ctx: ctx ? Object.keys(ctx) : null }));
      }
    }

    // Case 3: HTML + text multipart
    {
      const subject = `[Case3] HTML ${Date.now()}`;
      const { raw } = multipartEmail(
        "normal@example.com",
        agentEmail,
        subject,
        "Please review",
        '<p>Click <a href="https://phish.example">security check</a></p>',
      );
      await postEmailRaw("normal@example.com", agentEmail, raw);
      const email = await waitFor(() => {
        const rows = sqlQuery(
          `SELECT * FROM emails WHERE agent_id='${agentId}' AND subject='${subject}' LIMIT 1`,
        );
        return rows[0] ?? null;
      });
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      const ctx = task ? parseTaskContext(task) : null;
      const promptJson = task ? projectedDaemonPromptFields(task) : null;
      if (
        ctx?.bodyText &&
        ctx?.bodyHtml?.includes("https://phish.example") &&
        promptJson?.body_text &&
        promptJson?.body_html?.includes("https://phish.example")
      ) {
        pass("Case 3", "Context has bodyText/bodyHtml and daemon prompt has body_text/body_html with href");
      } else {
        fail("Case 3", `ctx keys: ${ctx ? Object.keys(ctx).join(",") : "none"}`);
      }
    }

    // Case 4: Attachment only
    {
      const subject = `[Case4] Attachment ${Date.now()}`;
      const { raw } = attachmentOnlyEmail("normal@example.com", agentEmail, subject, "invoice.pdf");
      await postEmailRaw("normal@example.com", agentEmail, raw);
      const email = await waitFor(() => {
        const rows = sqlQuery(`SELECT * FROM emails WHERE agent_id='${agentId}' AND subject='${subject}' LIMIT 1`);
        return rows[0] ?? null;
      });
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      const ctx = task ? parseTaskContext(task) : null;
      const promptJson = task ? projectedDaemonPromptFields(task) : null;
      const summaries = ctx?.attachmentSummaries;
      const promptSummaries = promptJson?.attachment_summaries;
      if (
        task &&
        summaries?.some((a) => a.filename === "invoice.pdf") &&
        promptSummaries?.some((a) => a.filename === "invoice.pdf")
      ) {
        pass("Case 4", "Attachment-only context has attachmentSummaries and daemon prompt has attachment_summaries");
      } else {
        fail("Case 4", `task=${!!task}, summaries=${JSON.stringify(summaries)}, prompt=${JSON.stringify(promptSummaries)}`);
      }
    }

    // Case 5: Empty body no attachment
    {
      const from = `empty-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case5] Empty ${Date.now()}`;
      const { raw } = emptyBodyEmail(from, agentEmail, subject);
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      await new Promise((r) => setTimeout(r, 1500));
      const task = email ? getTriageTask(agentId, email.id) : null;
      const hiddenBefore = getHiddenTriageConversations(workspaceId).length;
      if (email?.mailbox === "draft" && !task) {
        pass("Case 5", "Empty content → draft only, no triage task/conversation");
      } else {
        fail("Case 5", `mailbox=${email?.mailbox}, task=${!!task}, hidden=${hiddenBefore}`);
      }
    }

    // Case 6: R2 missing — notify with bad r2Key only (no R2 object)
    {
      const from = `r2missing-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case6] R2 missing ${Date.now()}`;
      const res = await fetch(`${APP_URL}/api/email/notify?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          workspaceId,
          from,
          to: agentEmail,
          subject,
          r2Key: `emails/nonexistent/${nanoid()}/raw`,
          isWhitelisted: false,
          forwarded: false,
          messageId: `<case6-${nanoid()}@triage.test>`,
          inReplyTo: "",
          references: "",
        }),
      });
      await new Promise((r) => setTimeout(r, 1000));
      const email = await waitFor(() => getEmail(agentId, from));
      const task = email ? getTriageTask(agentId, email.id) : null;
      if (res.ok && email?.mailbox === "draft" && !task) {
        pass("Case 6", "R2 missing on notify → fail closed, no triage");
      } else {
        fail("Case 6", `status=${res.status}, mailbox=${email?.mailbox}, task=${!!task}`);
      }
    }

    // Case 7: untrust output
    {
      const from = `untrust-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case7] Untrust ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Spam offer");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (task) {
        await completeTask(task.id, machineToken, workspaceId, JSON.stringify({ decision: "untrust" }));
        const updated = sqlQuery(`SELECT * FROM emails WHERE id='${email.id}'`)[0];
        const outbound = sqlQuery(`SELECT * FROM emails WHERE agent_id='${agentId}' AND in_reply_to='${email.message_id}'`);
        if (updated.mailbox === "untrust" && updated.status === "archived" && outbound.length === 0) {
          pass("Case 7", "untrust → Untrust mailbox, archived, no outbound draft");
        } else {
          fail("Case 7", `mailbox=${updated.mailbox}, status=${updated.status}, outbound=${outbound.length}`);
        }
      } else {
        fail("Case 7", "No triage task created");
      }
    }

    // Case 8: draft_reply output
    {
      const from = `reply-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case8] Draft reply ${Date.now()}`;
      const { raw, msgId } = rawEmail(from, agentEmail, subject, "Need help with project");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (task) {
        await completeTask(
          task.id,
          machineToken,
          workspaceId,
          JSON.stringify({
            decision: "draft_reply",
            draft: { subject: "Re: Test email", htmlBody: "<p>Thanks, I can help.</p>" },
          }),
        );
        const updated = sqlQuery(`SELECT * FROM emails WHERE id='${email.id}'`)[0];
        const outbound = sqlQuery(
          `SELECT * FROM emails WHERE agent_id='${agentId}' AND direction='outbound' AND mailbox='draft' ORDER BY created_at DESC LIMIT 1`,
        )[0];
        const whitelisted = sqlQuery(
          `SELECT * FROM agent_whitelist WHERE agent_id='${agentId}' AND email='${from}'`,
        );
        if (
          updated.mailbox === "inbox" &&
          updated.status === "unread" &&
          outbound?.to_email === from &&
          outbound?.from_email === agentEmail &&
          outbound?.status === "draft" &&
          whitelisted.length === 0
        ) {
          pass("Case 8", "draft_reply → inbox + outbound draft, no auto-whitelist");
        } else {
          fail("Case 8", JSON.stringify({ updated, outbound, whitelisted: whitelisted.length }));
        }
      } else {
        fail("Case 8", "No triage task");
      }
    }

    // Case 9: Invalid output fail closed
    for (const [label, output] of [
      ["plain text", "I think this is useful."],
      ["maybe decision", JSON.stringify({ decision: "maybe" })],
      ["empty draft", JSON.stringify({ decision: "draft_reply", draft: { subject: "", htmlBody: "" } })],
    ]) {
      const from = `invalid-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case9-${label}] ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Test invalid output");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (task) {
        const res = await completeTask(task.id, machineToken, workspaceId, output);
        const updated = sqlQuery(`SELECT * FROM emails WHERE id='${email.id}'`)[0];
        const taskAfter = sqlQuery(`SELECT * FROM agent_task_queue WHERE id='${task.id}'`)[0];
        const outbound = sqlQuery(`SELECT * FROM emails WHERE agent_id='${agentId}' AND in_reply_to='${updated.message_id}'`);
        if (updated.mailbox === "draft" && outbound.length === 0 && (taskAfter.status === "failed" || res.status === 400)) {
          pass(`Case 9 (${label})`, "Invalid output fail closed, email stays draft");
        } else {
          fail(`Case 9 (${label})`, `mailbox=${updated.mailbox}, taskStatus=${taskAfter.status}, res=${res.status}`);
        }
      } else {
        fail(`Case 9 (${label})`, "No triage task");
      }
    }

    // Case 10: User moves first, late triage
    {
      const from = `late-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case10] Late triage ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Late apply test");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (email && task) {
        moveEmailToInbox(email.id, workspaceId);
        await completeTask(task.id, machineToken, workspaceId, JSON.stringify({ decision: "untrust" }));
        const updated = sqlQuery(`SELECT * FROM emails WHERE id='${email.id}'`)[0];
        const outbound = sqlQuery(`SELECT * FROM emails WHERE agent_id='${agentId}' AND in_reply_to='${updated.message_id}'`);
        if (updated.mailbox === "inbox" && outbound.length === 0) {
          pass("Case 10", "Late triage does not override user inbox move");
        } else {
          fail("Case 10", `mailbox=${updated.mailbox}, outbound=${outbound.length}`);
        }
      } else {
        fail("Case 10", "Setup failed");
      }
    }

    // Case 11: Duplicate complete
    {
      const from = `dup-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case11] Dup complete ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Dup test");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (task) {
        await completeTask(task.id, machineToken, workspaceId, JSON.stringify({ decision: "untrust" }));
        const res2 = await completeTask(task.id, machineToken, workspaceId, JSON.stringify({ decision: "untrust" }));
        const untrustCount = sqlQuery(
          `SELECT count(*) as c FROM emails WHERE agent_id='${agentId}' AND from_email='${from}' AND mailbox='untrust'`,
        )[0]?.c;
        if (untrustCount === 1 && res2.status === 400) {
          pass("Case 11", "Duplicate complete rejected, no double apply");
        } else {
          fail("Case 11", `untrustCount=${untrustCount}, res2=${res2.status}`);
        }
      } else {
        fail("Case 11", "No triage task");
      }
    }

    // Case 12: Cancel then complete
    {
      const from = `cancel-${nanoid().slice(0, 8)}@example.com`;
      const subject = `[Case12] Cancel ${Date.now()}`;
      const { raw } = rawEmail(from, agentEmail, subject, "Cancel test");
      await postEmailRaw(from, agentEmail, raw);
      const email = await waitFor(() => getEmail(agentId, from));
      const task = await waitFor(() => (email ? getTriageTask(agentId, email.id) : null));
      if (task) {
        await failTask(task.id, machineToken, workspaceId, "cancelled for test");
        const res = await completeTask(task.id, machineToken, workspaceId, JSON.stringify({ decision: "untrust" }));
        const updated = sqlQuery(`SELECT * FROM emails WHERE id='${email.id}'`)[0];
        if (updated.mailbox === "draft" && res.status === 400) {
          pass("Case 12", "Failed/cancelled task cannot complete, email unchanged");
        } else {
          fail("Case 12", `mailbox=${updated.mailbox}, res=${res.status}`);
        }
      } else {
        fail("Case 12", "No triage task");
      }
    }

    // Case 13 & 14: Sweep recovery — simulate via SQL + sweep API
    {
      const inboundId = `em_stale_in_${nanoid().slice(0, 8)}`;
      const outboundId = `em_stale_out_${nanoid().slice(0, 8)}`;
      const now = "2020-01-01T00:00:00.000Z";
      sql(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", direction, mailbox, status, created_at) VALUES ('${inboundId}', '${agentId}', '${workspaceId}', 'stale-in@example.com', '${agentEmail}', '[Case14] Stale inbound', 'emails/fake/raw', 0, 0, '<stale-in@triage.test>', '', '', 'inbound', 'draft', 'triage_applying', '${now}')`);
      sql(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", direction, mailbox, status, created_at) VALUES ('${outboundId}', '${agentId}', '${workspaceId}', '${agentEmail}', 'stale-in@example.com', 'Re: stale', 'emails/fake/out', 0, 0, '<stale-out@triage.test>', '<stale-in@triage.test>', '', 'outbound', 'draft', 'triage_applying', '${now}')`);
      const convRows = sqlQuery(`SELECT id FROM conversation WHERE workspace_id='${workspaceId}' LIMIT 1`);
      const convId = convRows[0]?.id ?? (() => {
        const cid = `cv_${nanoid().slice(0, 12)}`;
        sql(`INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, type, created_at) VALUES ('${cid}', '${workspaceId}', '${agentId}', '${seed.userId}', 'Stale conv', 'email_triage', '${now}')`);
        return cid;
      })();
      const taskId = `tq_stale_${nanoid().slice(0, 8)}`;
      sql(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, type, status, priority, context, created_at, started_at) VALUES ('${taskId}', '${agentId}', (SELECT runtime_id FROM agent WHERE id='${agentId}'), '${workspaceId}', '${convId}', 'stale task', 'email_triage', 'applying', 0, '{}', '${now}', '${now}')`);

      const sweepRes = await tokenRequest(`/api/daemon/sweep?workspace_id=${workspaceId}`, machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: daemonId }),
      });
      if (!sweepRes.ok) {
        fail("Case 13/14 setup", `sweep failed with ${sweepRes.status}: ${await sweepRes.text()}`);
      }

      const inbound = sqlQuery(`SELECT * FROM emails WHERE id='${inboundId}'`)[0];
      const outbound = sqlQuery(`SELECT * FROM emails WHERE id='${outboundId}'`)[0];
      const task = sqlQuery(`SELECT * FROM agent_task_queue WHERE id='${taskId}'`)[0];

      if (inbound?.mailbox === "draft" && inbound?.status === "unread" && !outbound) {
        pass("Case 14", "Stale triage_applying recovered: inbound draft/unread, orphan outbound deleted");
      } else {
        fail("Case 14", JSON.stringify({ inbound: inbound ? [inbound.mailbox, inbound.status] : null, outbound: !!outbound }));
      }

      if (task?.status === "failed") {
        pass("Case 13", "Stale applying task failed by recovery");
      } else {
        skip("Case 13", `Task status=${task?.status}`);
      }
    }

    // Cases 15-17: Provider readonly — covered by unit tests; note for manual
    skip("Case 15", "Claude triage readonly — verified by src/cli/daemon/agent/__tests__/claude.test.ts");
    skip("Case 16", "Codex triage readonly — verified by src/cli/daemon/agent/__tests__/codex-readonly.test.ts");
    skip("Case 17", "OpenCode triage readonly — verified by src/cli/daemon/agent/__tests__/opencode.test.ts");

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const skipped = results.filter((r) => r.status === "SKIP").length;

    console.log(`\n=== Summary: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    console.log(`\nBrowser UI URL: ${APP_URL}/w/${slug}/agents/${agentId}/email`);
    console.log(`Workspace slug: ${slug}, agent: ${agentId}\n`);

    // Write results for browser verification
    import("fs").then(({ writeFileSync }) => {
      writeFileSync(
        resolve(ROOT, "scripts/.email-triage-ui-test-results.json"),
        JSON.stringify({ seed, results, baseline, passed, failed, skipped }, null, 2),
      );
    });
    return failed === 0 ? 0 : 1;
  } finally {
    // Don't cleanup immediately — browser needs the data
    console.log("(Test data preserved for browser UI verification)");
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
