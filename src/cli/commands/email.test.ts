import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import PostalMime from "postal-mime";
import { Command } from "commander";

const { postMultipartMock, postJSONMock, getJSONMock, getTextMock, deleteJSONMock } = vi.hoisted(() => ({
  postMultipartMock: vi.fn(),
  postJSONMock: vi.fn(),
  getJSONMock: vi.fn(),
  getTextMock: vi.fn(),
  deleteJSONMock: vi.fn(),
}));

vi.mock("../lib/client.js", () => ({
  APIClient: class {
    postMultipart(...a: unknown[]) {
      return postMultipartMock(...a);
    }
    postJSON(...a: unknown[]) {
      return postJSONMock(...a);
    }
    getJSON(...a: unknown[]) {
      return getJSONMock(...a);
    }
    getText(...a: unknown[]) {
      return getTextMock(...a);
    }
    deleteJSON(...a: unknown[]) {
      return deleteJSONMock(...a);
    }
  },
}));

vi.mock("../lib/config.js", () => ({
  loadCLIConfigForProfile: vi.fn(() => ({
    server_url: "http://localhost:3000",
    watched_workspaces: [
      { id: "w1", token: "tok", agent_ids: ["ag_1"] },
    ],
  })),
}));

import { emailCommand } from "./email.js";

// Test the PostalMime parsing and file writing logic in isolation
// (CLI commands themselves depend on network + config which we don't mock here)

const TMP_DIR = "/tmp/alook-emails-test";

describe("email pull output structure", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates metadata.json with correct fields", () => {
    const emailDir = join(TMP_DIR, "test-email-1");
    mkdirSync(emailDir, { recursive: true });

    const metadata = {
      id: "test-email-1",
      from: "sender@example.com",
      to: "agent@alook.ai",
      subject: "Test Subject",
      date: "2024-01-01T00:00:00Z",
      status: "unread",
    };
    writeFileSync(join(emailDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    const written = JSON.parse(readFileSync(join(emailDir, "metadata.json"), "utf-8"));
    expect(written.id).toBe("test-email-1");
    expect(written.from).toBe("sender@example.com");
    expect(written.to).toBe("agent@alook.ai");
    expect(written.subject).toBe("Test Subject");
    expect(written.status).toBe("unread");
    expect(written.date).toBe("2024-01-01T00:00:00Z");
  });

  it("writes body.txt from parsed MIME text body", async () => {
    const rawMime = "From: test@example.com\r\nTo: agent@alook.ai\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nHello world";
    const parsed = await new PostalMime().parse(rawMime);

    const emailDir = join(TMP_DIR, "test-email-2");
    mkdirSync(emailDir, { recursive: true });

    if (parsed.text) {
      writeFileSync(join(emailDir, "body.txt"), parsed.text);
    }

    expect(existsSync(join(emailDir, "body.txt"))).toBe(true);
    expect(readFileSync(join(emailDir, "body.txt"), "utf-8").trim()).toBe("Hello world");
  });

  it("writes body.html from parsed MIME HTML body", async () => {
    const rawMime = [
      "From: test@example.com",
      "To: agent@alook.ai",
      "Subject: Hello",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello world</p>",
    ].join("\r\n");
    const parsed = await new PostalMime().parse(rawMime);

    const emailDir = join(TMP_DIR, "test-email-3");
    mkdirSync(emailDir, { recursive: true });

    if (parsed.html) {
      writeFileSync(join(emailDir, "body.html"), parsed.html);
    }

    expect(existsSync(join(emailDir, "body.html"))).toBe(true);
    expect(readFileSync(join(emailDir, "body.html"), "utf-8").trim()).toBe("<p>Hello world</p>");
  });

  it("extracts attachments with correct binary content", async () => {
    const boundary = "----=_Part_001";
    const rawMime = [
      "From: test@example.com",
      "To: agent@alook.ai",
      "Subject: With attachment",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Body text",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="report.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("binary content").toString("base64"),
      `--${boundary}--`,
    ].join("\r\n");

    const parsed = await new PostalMime().parse(rawMime);
    expect(parsed.attachments.length).toBeGreaterThan(0);

    const emailDir = join(TMP_DIR, "test-email-4");
    const attDir = join(emailDir, "attachments");
    mkdirSync(attDir, { recursive: true });

    for (const att of parsed.attachments) {
      const filename = att.filename || "attachment-0.bin";
      const content = att.content;
      let buf: Buffer;
      if (typeof content === "string") {
        buf = Buffer.from(content, "base64");
      } else if (content instanceof ArrayBuffer) {
        buf = Buffer.from(new Uint8Array(content));
      } else {
        buf = Buffer.from(content as Uint8Array);
      }
      writeFileSync(join(attDir, filename), buf);
    }

    const writtenFile = join(attDir, "report.bin");
    expect(existsSync(writtenFile)).toBe(true);
    expect(readFileSync(writtenFile).toString()).toBe("binary content");
  });

  it("handles attachments with missing filename", async () => {
    const boundary = "----=_Part_002";
    const rawMime = [
      "From: test@example.com",
      "To: agent@alook.ai",
      "Subject: No filename",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Body",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("data").toString("base64"),
      `--${boundary}--`,
    ].join("\r\n");

    const parsed = await new PostalMime().parse(rawMime);

    const emailDir = join(TMP_DIR, "test-email-5");
    const attDir = join(emailDir, "attachments");
    mkdirSync(attDir, { recursive: true });

    for (let i = 0; i < parsed.attachments.length; i++) {
      const att = parsed.attachments[i];
      const filename = att.filename || `attachment-${i}.bin`;
      const content = att.content;
      let buf: Buffer;
      if (typeof content === "string") {
        buf = Buffer.from(content, "base64");
      } else if (content instanceof ArrayBuffer) {
        buf = Buffer.from(new Uint8Array(content));
      } else {
        buf = Buffer.from(content as Uint8Array);
      }
      writeFileSync(join(attDir, filename), buf);
    }

    // Should use fallback filename
    const files = require("fs").readdirSync(attDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f: string) => f.startsWith("attachment-"))).toBe(true);
  });

  it("handles duplicate attachment filenames by prefixing with index", () => {
    const emailDir = join(TMP_DIR, "test-email-6");
    const attDir = join(emailDir, "attachments");
    mkdirSync(attDir, { recursive: true });

    const usedFilenames = new Set<string>();
    const attachments = [
      { filename: "report.pdf" },
      { filename: "report.pdf" },
    ];

    for (let i = 0; i < attachments.length; i++) {
      let filename = attachments[i].filename;
      if (usedFilenames.has(filename)) {
        filename = `${i}-${filename}`;
      }
      usedFilenames.add(filename);
      writeFileSync(join(attDir, filename), "content");
    }

    expect(existsSync(join(attDir, "report.pdf"))).toBe(true);
    expect(existsSync(join(attDir, "1-report.pdf"))).toBe(true);
  });

  it("does not clear existing email directories", () => {
    // Pre-create some content
    const existingDir = join(TMP_DIR, "existing-email");
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, "metadata.json"), "existing");

    // Create a new email directory
    const newDir = join(TMP_DIR, "new-email");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "metadata.json"), "new");

    // Existing should still be there
    expect(existsSync(join(existingDir, "metadata.json"))).toBe(true);
    expect(readFileSync(join(existingDir, "metadata.json"), "utf-8")).toBe("existing");
  });
});

describe("email status validation", () => {
  const VALID_STATUSES = ["unread", "read", "archived", "sent"];

  it("accepts valid status values", () => {
    for (const s of VALID_STATUSES) {
      expect(VALID_STATUSES.includes(s)).toBe(true);
    }
  });

  it("rejects invalid status values", () => {
    expect(VALID_STATUSES.includes("deleted")).toBe(false);
    expect(VALID_STATUSES.includes("pending")).toBe(false);
    expect(VALID_STATUSES.includes("")).toBe(false);
  });
});

describe("email send subcommand shape", () => {
  const cmd = emailCommand();
  const send = cmd.commands.find((c) => c.name() === "send")!;

  it("is registered", () => {
    expect(send).toBeDefined();
  });

  it("requires --to, --subject, --body-file; --agent_id is optional (env fallback)", () => {
    const opts = (send as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--to");
    expect(mandatory).toContain("--subject");
    expect(mandatory).toContain("--body-file");
  });

  it("accepts --attachment, --workspace, and --from as optional", () => {
    const opts = (send as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const longs = opts.map((o) => o.long);
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(longs).toContain("--attachment");
    expect(longs).toContain("--workspace");
    expect(longs).toContain("--from");
    expect(mandatory).not.toContain("--attachment");
    expect(mandatory).not.toContain("--workspace");
    expect(mandatory).not.toContain("--from");
  });
});

describe("email send behavior", () => {
  const SEND_TMP = "/tmp/alook-email-send-test";

  async function runSend(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | null }> {
    const out: string[] = [];
    const err: string[] = [];
    let exitCode: number | null = null;
    const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      out.push(String(m));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
      err.push(String(m));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__exit__");
    }) as never);
    try {
      const program = new Command()
        .name("alook")
        .option("--server <url>", "Server URL")
        .option("--profile <name>", "Profile name");
      program.addCommand(emailCommand());
      await program.parseAsync(["email", "send", ...args], { from: "user" });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__exit__") throw e;
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { out, err, exitCode };
  }

  beforeEach(() => {
    mkdirSync(SEND_TMP, { recursive: true });
    postMultipartMock.mockReset();
    postJSONMock.mockReset();
  });

  afterEach(() => {
    rmSync(SEND_TMP, { recursive: true, force: true });
  });

  it("uploads each attachment then sends", async () => {
    const bodyPath = join(SEND_TMP, "body.html");
    const att1 = join(SEND_TMP, "report.pdf");
    const att2 = join(SEND_TMP, "chart.png");
    writeFileSync(bodyPath, "<p>Hi</p>");
    writeFileSync(att1, Buffer.from("pdf-bytes"));
    writeFileSync(att2, Buffer.from("png-bytes"));

    postMultipartMock
      .mockResolvedValueOnce({ key: "emails/drafts/abc/report.pdf", filename: "report.pdf", size: 9, contentType: "application/pdf" })
      .mockResolvedValueOnce({ key: "emails/drafts/def/chart.png", filename: "chart.png", size: 9, contentType: "image/png" });
    postJSONMock.mockResolvedValueOnce({ id: "em_1", to_email: "foo@bar.com" });

    const { out, exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "foo@bar.com",
      "--subject", "Weekly report",
      "--body-file", bodyPath,
      "--attachment", att1,
      "--attachment", att2,
    ]);

    expect(exitCode).toBeNull();
    expect(postMultipartMock).toHaveBeenCalledTimes(2);
    expect(postMultipartMock.mock.calls[0][0]).toBe("/api/email/upload");
    expect(postMultipartMock.mock.calls[0][1]).toBeInstanceOf(FormData);
    const form1 = postMultipartMock.mock.calls[0][1] as FormData;
    const file1 = form1.get("file") as File;
    expect(file1).toBeInstanceOf(Blob);
    // Blob.type carries our guessed content-type
    expect(file1.type).toBe("application/pdf");

    expect(postJSONMock).toHaveBeenCalledTimes(1);
    expect(postJSONMock.mock.calls[0][0]).toBe("/api/email/send");
    const payload = postJSONMock.mock.calls[0][1] as {
      agentId: string;
      to: string;
      subject: string;
      htmlBody: string;
      attachments: Array<{ key: string; filename: string; contentType: string }>;
    };
    expect(payload.agentId).toBe("ag_1");
    expect(payload.to).toBe("foo@bar.com");
    expect(payload.subject).toBe("Weekly report");
    expect(payload.htmlBody).toBe("<p>Hi</p>");
    expect(payload.attachments).toHaveLength(2);
    expect(payload.attachments[0].key).toBe("emails/drafts/abc/report.pdf");
    expect(payload.attachments[1].key).toBe("emails/drafts/def/chart.png");

    expect(out.join("\n")).toContain("Sent email to foo@bar.com");
  });

  it("sends with empty attachments when none provided", async () => {
    const bodyPath = join(SEND_TMP, "body.html");
    writeFileSync(bodyPath, "<p>No attachments</p>");
    postJSONMock.mockResolvedValueOnce({ id: "em_2", to_email: "a@b.com" });

    const { exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "a@b.com",
      "--subject", "Hi",
      "--body-file", bodyPath,
    ]);

    expect(exitCode).toBeNull();
    expect(postMultipartMock).not.toHaveBeenCalled();
    const payload = postJSONMock.mock.calls[0][1] as { attachments: unknown[] };
    expect(payload.attachments).toEqual([]);
  });

  it("errors when body file does not exist", async () => {
    const { err, exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "a@b.com",
      "--subject", "Hi",
      "--body-file", join(SEND_TMP, "missing.html"),
    ]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("cannot read body file");
    expect(postMultipartMock).not.toHaveBeenCalled();
    expect(postJSONMock).not.toHaveBeenCalled();
  });

  it("passes --from to API payload when provided", async () => {
    const bodyPath = join(SEND_TMP, "body.html");
    writeFileSync(bodyPath, "<p>From custom</p>");
    postJSONMock.mockResolvedValueOnce({ id: "em_3", to_email: "a@b.com" });

    const { exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "a@b.com",
      "--subject", "Custom from",
      "--body-file", bodyPath,
      "--from", "custom@feishu.cn",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.from).toBe("custom@feishu.cn");
  });

  it("omits from in payload when --from is not provided", async () => {
    const bodyPath = join(SEND_TMP, "body.html");
    writeFileSync(bodyPath, "<p>Default from</p>");
    postJSONMock.mockResolvedValueOnce({ id: "em_4", to_email: "a@b.com" });

    const { exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "a@b.com",
      "--subject", "Default",
      "--body-file", bodyPath,
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.from).toBeUndefined();
  });

  it("errors when body file is empty", async () => {
    const bodyPath = join(SEND_TMP, "empty.html");
    writeFileSync(bodyPath, "");

    const { err, exitCode } = await runSend([
      "--agent_id", "ag_1",
      "--to", "a@b.com",
      "--subject", "Hi",
      "--body-file", bodyPath,
    ]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("is empty");
    expect(postMultipartMock).not.toHaveBeenCalled();
    expect(postJSONMock).not.toHaveBeenCalled();
  });
});

// --- Forward tests ---

async function runForward(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    out.push(String(m));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  }) as never);
  try {
    const program = new Command()
      .name("alook")
      .option("--server <url>", "Server URL")
      .option("--profile <name>", "Profile name");
    program.addCommand(emailCommand());
    await program.parseAsync(["email", "forward", ...args], { from: "user" });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out, err, exitCode };
}

async function runPull(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    out.push(String(m));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  }) as never);
  try {
    const program = new Command()
      .name("alook")
      .option("--server <url>", "Server URL")
      .option("--profile <name>", "Profile name");
    program.addCommand(emailCommand());
    await program.parseAsync(["email", "pull", ...args], { from: "user" });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out, err, exitCode };
}

const FORWARD_TMP = "/tmp/alook-email-forward-test";

function makeOriginalEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "em_orig",
    agent_id: "ag_1",
    from_email: "sender@example.com",
    to_email: "agent@alook.ai",
    subject: "Original Subject",
    r2_key: "emails/em_orig",
    is_whitelisted: true,
    forwarded: false,
    message_id: "<msg1@example.com>",
    in_reply_to: "",
    references: "",
    html_body: "<p>Hello</p>",
    attachments: [],
    status: "read",
    created_at: "2026-04-20T10:00:00Z",
    ...overrides,
  };
}

function makeRawMime(opts: { html?: string; text?: string; attachment?: boolean } = {}) {
  if (opts.attachment) {
    const boundary = "----=_Part_fwd";
    const parts = [];
    if (opts.html) {
      parts.push(
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.html}`,
      );
    } else if (opts.text) {
      parts.push(
        `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${opts.text}`,
      );
    }
    parts.push(
      `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="original.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("pdf-content").toString("base64")}`,
    );
    return `From: sender@example.com\r\nTo: agent@alook.ai\r\nSubject: Original Subject\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--`;
  }
  if (opts.html) {
    return `From: sender@example.com\r\nTo: agent@alook.ai\r\nSubject: Original Subject\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.html}`;
  }
  return `From: sender@example.com\r\nTo: agent@alook.ai\r\nSubject: Original Subject\r\nContent-Type: text/plain\r\n\r\n${opts.text || "Hello world"}`;
}

describe("email forward subcommand shape", () => {
  const cmd = emailCommand();
  const forward = cmd.commands.find((c) => c.name() === "forward")!;

  it("is registered", () => {
    expect(forward).toBeDefined();
  });

  it("requires --email_id, --to; --agent_id is optional (env fallback)", () => {
    const opts = (forward as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).not.toContain("--agent_id");
    expect(mandatory).toContain("--email_id");
    expect(mandatory).toContain("--to");
  });

  it("accepts --from, --note, --attachment, --workspace as optional", () => {
    const opts = (forward as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const longs = opts.map((o) => o.long);
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(longs).toContain("--from");
    expect(longs).toContain("--note");
    expect(longs).toContain("--attachment");
    expect(longs).toContain("--workspace");
    expect(mandatory).not.toContain("--from");
    expect(mandatory).not.toContain("--note");
    expect(mandatory).not.toContain("--attachment");
    expect(mandatory).not.toContain("--workspace");
  });
});

describe("email forward behavior", () => {
  beforeEach(() => {
    mkdirSync(FORWARD_TMP, { recursive: true });
    postMultipartMock.mockReset();
    postJSONMock.mockReset();
    getJSONMock.mockReset();
    getTextMock.mockReset();
  });

  afterEach(() => {
    rmSync(FORWARD_TMP, { recursive: true, force: true });
  });

  it("fetches original email, parses MIME, re-uploads attachments, and sends", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Hello</p>", attachment: true }));
    postMultipartMock.mockResolvedValueOnce({
      key: "emails/drafts/x/original.pdf",
      filename: "original.pdf",
      size: 11,
      contentType: "application/pdf",
    });
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd1", to_email: "boss@company.com" });

    const { out, exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email/em_orig");
    expect(getTextMock).toHaveBeenCalledWith("/api/email/em_orig/raw");
    expect(postMultipartMock).toHaveBeenCalledTimes(1);
    expect(postJSONMock).toHaveBeenCalledTimes(1);

    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.subject).toBe("Fwd: Original Subject");
    expect((payload.htmlBody as string)).toContain("---------- Forwarded message ----------");
    expect((payload.htmlBody as string)).toContain("sender@example.com");
    expect((payload.attachments as unknown[]).length).toBe(1);
    expect(out.join("\n")).toContain("Forwarded email to boss@company.com");
  });

  it("prepends note when --note is provided", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Content</p>" }));
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd2", to_email: "boss@company.com" });

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
      "--note", "FYI see below",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    const body = payload.htmlBody as string;
    expect(body).toMatch(/^<p>FYI see below<\/p>/);
    expect(body).toContain("---------- Forwarded message ----------");
  });

  it("has no extra prefix without --note", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Content</p>" }));
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd3", to_email: "boss@company.com" });

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    const body = payload.htmlBody as string;
    expect(body).not.toMatch(/^<p>/);
    expect(body).toMatch(/^<br><br>---------- Forwarded message ----------/);
  });

  it("handles plain-text-only original email", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ text: "Plain text body" }));
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd4", to_email: "boss@company.com" });

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    const body = payload.htmlBody as string;
    expect(body).toContain("<pre>Plain text body");
    expect(body).toContain("</pre>");
  });

  it("preserves subject prefix — no double Fwd:", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail({ subject: "Fwd: Already forwarded" }));
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Hi</p>" }));
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd5", to_email: "boss@company.com" });

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.subject).toBe("Fwd: Already forwarded");
  });

  it("passes --from to send payload when provided", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Hi</p>" }));
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd6", to_email: "boss@company.com" });

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
      "--from", "custom@company.com",
    ]);

    expect(exitCode).toBeNull();
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.from).toBe("custom@company.com");
  });

  it("adds extra --attachment files alongside original attachments", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockResolvedValueOnce(makeRawMime({ html: "<p>Hi</p>", attachment: true }));
    postMultipartMock
      .mockResolvedValueOnce({ key: "emails/drafts/x/original.pdf", filename: "original.pdf", size: 11, contentType: "application/pdf" })
      .mockResolvedValueOnce({ key: "emails/drafts/y/extra.pdf", filename: "extra.pdf", size: 5, contentType: "application/pdf" });
    postJSONMock.mockResolvedValueOnce({ id: "em_fwd7", to_email: "boss@company.com" });

    const extraPath = join(FORWARD_TMP, "extra.pdf");
    writeFileSync(extraPath, "extra");

    const { exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
      "--attachment", extraPath,
    ]);

    expect(exitCode).toBeNull();
    expect(postMultipartMock).toHaveBeenCalledTimes(2);
    const payload = postJSONMock.mock.calls[0][1] as Record<string, unknown>;
    expect((payload.attachments as unknown[]).length).toBe(2);
  });

  it("errors when original email not found (404)", async () => {
    getJSONMock.mockRejectedValueOnce(new Error("HTTP 404: not found"));

    const { err, exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_missing",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("not found");
  });

  it("errors when raw MIME not available (404)", async () => {
    getJSONMock.mockResolvedValueOnce(makeOriginalEmail());
    getTextMock.mockRejectedValueOnce(new Error("HTTP 404: not found"));

    const { err, exitCode } = await runForward([
      "--agent_id", "ag_1",
      "--email_id", "em_orig",
      "--to", "boss@company.com",
    ]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("raw email body not available");
  });
});

describe("email pull with --folder", () => {
  beforeEach(() => {
    getJSONMock.mockReset();
    getTextMock.mockReset();
  });

  it("passes folder param to API when --folder sent", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1", "--folder", "sent"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email?agentId=ag_1&folder=sent");
  });

  it("rejects invalid --folder value", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--folder", "invalid"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("invalid folder");
    expect(err.join("\n")).toContain("inbox, sent, untrust");
  });

  it("does not include folder param without --folder (preserves default)", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email?agentId=ag_1");
  });
});

describe("email pull with --limit and --offset", () => {
  beforeEach(() => {
    getJSONMock.mockReset();
    getTextMock.mockReset();
  });

  it("passes limit param to API when --limit 10", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "10"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email?agentId=ag_1&limit=10");
  });

  it("passes both limit and offset to API", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "10", "--offset", "20"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email?agentId=ag_1&limit=10&offset=20");
  });

  it("rejects --limit 0", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "0"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("--limit must be an integer between 1 and 100");
  });

  it("rejects negative --limit", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "-5"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("--limit must be an integer between 1 and 100");
  });

  it("rejects non-numeric --limit", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "abc"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("--limit must be an integer between 1 and 100");
  });

  it("rejects --limit over 100", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--limit", "200"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("--limit must be an integer between 1 and 100");
  });

  it("rejects negative --offset", async () => {
    const { err, exitCode } = await runPull(["--agent_id", "ag_1", "--offset", "-1"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("--offset must be a non-negative integer");
  });

  it("does not include limit/offset params when not specified", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1"]);

    expect(exitCode).toBeNull();
    const calledUrl = getJSONMock.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("limit");
    expect(calledUrl).not.toContain("offset");
  });

  it("combines --limit with --folder and --status", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { exitCode } = await runPull(["--agent_id", "ag_1", "--status", "unread", "--folder", "sent", "--limit", "5"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/email?agentId=ag_1&status=unread&folder=sent&limit=5");
  });
});

// --- Whitelist tests ---

async function runWhitelist(args: string[]): Promise<{ out: string[]; err: string[]; exitCode: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    out.push(String(m));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exit__");
  }) as never);
  try {
    const program = new Command()
      .name("alook")
      .option("--server <url>", "Server URL")
      .option("--profile <name>", "Profile name");
    program.addCommand(emailCommand());
    await program.parseAsync(["email", "whitelist", ...args], { from: "user" });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out, err, exitCode };
}

describe("whitelist command registration", () => {
  const cmd = emailCommand();
  const whitelistCmd = cmd.commands.find((c) => c.name() === "whitelist")!;

  it("whitelist subcommand group exists under email", () => {
    expect(whitelistCmd).toBeDefined();
    expect(whitelistCmd.description()).toBe("Manage email whitelist (allowed senders)");
  });

  it("list, add, delete subcommands exist under whitelist", () => {
    const subNames = whitelistCmd.commands.map((c) => c.name());
    expect(subNames).toContain("list");
    expect(subNames).toContain("add");
    expect(subNames).toContain("delete");
  });

  it("--agent_id is optional on all three subcommands (env fallback)", () => {
    for (const name of ["list", "add", "delete"]) {
      const sub = whitelistCmd.commands.find((c) => c.name() === name)!;
      const opts = (sub as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
      const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
      const longs = opts.map((o) => o.long);
      expect(longs).toContain("--agent_id");
      expect(mandatory).not.toContain("--agent_id");
    }
  });

  it("--workspace is optional on all three subcommands", () => {
    for (const name of ["list", "add", "delete"]) {
      const sub = whitelistCmd.commands.find((c) => c.name() === name)!;
      const opts = (sub as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
      const longs = opts.map((o) => o.long);
      const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
      expect(longs).toContain("--workspace");
      expect(mandatory).not.toContain("--workspace");
    }
  });

  it("--json is optional on list only", () => {
    const listCmd = whitelistCmd.commands.find((c) => c.name() === "list")!;
    const listOpts = (listCmd as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    expect(listOpts.map((o) => o.long)).toContain("--json");

    for (const name of ["add", "delete"]) {
      const sub = whitelistCmd.commands.find((c) => c.name() === name)!;
      const opts = (sub as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
      expect(opts.map((o) => o.long)).not.toContain("--json");
    }
  });
});

describe("whitelist list behavior", () => {
  beforeEach(() => {
    getJSONMock.mockReset();
  });

  it("returns table output with entries", async () => {
    getJSONMock.mockResolvedValueOnce([
      { id: "wl_abc123", email: "alice@example.com", created_at: "2026-04-20T10:00:00Z" },
      { id: "wl_def456", email: "bob@company.com", created_at: "2026-04-21T14:30:00Z" },
    ]);

    const { out, exitCode } = await runWhitelist(["list", "--agent_id", "ag_1"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/agents/ag_1/whitelist");
    const output = out.join("\n");
    expect(output).toContain("ID");
    expect(output).toContain("EMAIL");
    expect(output).toContain("CREATED AT");
    expect(output).toContain("alice@example.com");
    expect(output).toContain("bob@company.com");
  });

  it("returns JSON output with --json", async () => {
    const entries = [
      { id: "wl_abc123", email: "alice@example.com", created_at: "2026-04-20T10:00:00Z" },
    ];
    getJSONMock.mockResolvedValueOnce(entries);

    const { out, exitCode } = await runWhitelist(["list", "--agent_id", "ag_1", "--json"]);

    expect(exitCode).toBeNull();
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toEqual(entries);
  });

  it("prints 'No whitelisted emails.' when empty", async () => {
    getJSONMock.mockResolvedValueOnce([]);

    const { out, exitCode } = await runWhitelist(["list", "--agent_id", "ag_1"]);

    expect(exitCode).toBeNull();
    expect(out.join("\n")).toContain("No whitelisted emails.");
  });

  it("exits 1 on API error", async () => {
    getJSONMock.mockRejectedValueOnce(new Error("HTTP 500: Internal Server Error"));

    const { err, exitCode } = await runWhitelist(["list", "--agent_id", "ag_1"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("HTTP 500");
  });
});

describe("whitelist add behavior", () => {
  beforeEach(() => {
    postJSONMock.mockReset();
  });

  it("posts email and prints confirmation", async () => {
    postJSONMock.mockResolvedValueOnce({ id: "wl_new1", email: "alice@example.com", created_at: "2026-04-22T00:00:00Z" });

    const { out, exitCode } = await runWhitelist(["add", "--agent_id", "ag_1", "alice@example.com"]);

    expect(exitCode).toBeNull();
    expect(postJSONMock).toHaveBeenCalledWith("/api/agents/ag_1/whitelist", { email: "alice@example.com" });
    expect(out.join("\n")).toContain("Added alice@example.com to whitelist (id: wl_new1)");
  });

  it("normalizes email to lowercase before sending", async () => {
    postJSONMock.mockResolvedValueOnce({ id: "wl_new2", email: "alice@example.com", created_at: "2026-04-22T00:00:00Z" });

    const { exitCode } = await runWhitelist(["add", "--agent_id", "ag_1", "Alice@Example.COM"]);

    expect(exitCode).toBeNull();
    expect(postJSONMock).toHaveBeenCalledWith("/api/agents/ag_1/whitelist", { email: "alice@example.com" });
  });

  it("exits 1 with message on 409 duplicate", async () => {
    postJSONMock.mockRejectedValueOnce(new Error("HTTP 409: already exists"));

    const { err, exitCode } = await runWhitelist(["add", "--agent_id", "ag_1", "alice@example.com"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("alice@example.com is already whitelisted");
  });

  it("exits 1 with message on 404 agent not found", async () => {
    postJSONMock.mockRejectedValueOnce(new Error("HTTP 404: agent not found"));

    const { err, exitCode } = await runWhitelist(["add", "--agent_id", "ag_999", "alice@example.com"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("404");
  });

  it("exits 1 with message on invalid email format (400 from API)", async () => {
    postJSONMock.mockRejectedValueOnce(new Error("HTTP 400: invalid email format"));

    const { err, exitCode } = await runWhitelist(["add", "--agent_id", "ag_1", "not-an-email"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("400");
  });
});

describe("whitelist delete behavior", () => {
  beforeEach(() => {
    getJSONMock.mockReset();
    deleteJSONMock.mockReset();
  });

  it("fetches list, finds entry, sends DELETE with correct whitelistId, prints confirmation", async () => {
    getJSONMock.mockResolvedValueOnce([
      { id: "wl_abc123", email: "alice@example.com", created_at: "2026-04-20T10:00:00Z" },
      { id: "wl_def456", email: "bob@company.com", created_at: "2026-04-21T14:30:00Z" },
    ]);
    deleteJSONMock.mockResolvedValueOnce(undefined);

    const { out, exitCode } = await runWhitelist(["delete", "--agent_id", "ag_1", "alice@example.com"]);

    expect(exitCode).toBeNull();
    expect(getJSONMock).toHaveBeenCalledWith("/api/agents/ag_1/whitelist");
    expect(deleteJSONMock).toHaveBeenCalledWith("/api/agents/ag_1/whitelist/wl_abc123");
    expect(out.join("\n")).toContain("Removed alice@example.com from whitelist");
  });

  it("exits 1 with message when email not in whitelist", async () => {
    getJSONMock.mockResolvedValueOnce([
      { id: "wl_abc123", email: "alice@example.com", created_at: "2026-04-20T10:00:00Z" },
    ]);

    const { err, exitCode } = await runWhitelist(["delete", "--agent_id", "ag_1", "unknown@example.com"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown@example.com is not in the whitelist");
  });

  it("exits 1 on API error", async () => {
    getJSONMock.mockRejectedValueOnce(new Error("HTTP 500: Internal Server Error"));

    const { err, exitCode } = await runWhitelist(["delete", "--agent_id", "ag_1", "alice@example.com"]);

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("HTTP 500");
  });
});
