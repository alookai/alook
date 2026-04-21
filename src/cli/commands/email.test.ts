import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import PostalMime from "postal-mime";
import { Command } from "commander";

const { postMultipartMock, postJSONMock } = vi.hoisted(() => ({
  postMultipartMock: vi.fn(),
  postJSONMock: vi.fn(),
}));

vi.mock("../lib/client.js", () => ({
  APIClient: class {
    postMultipart(...a: unknown[]) {
      return postMultipartMock(...a);
    }
    postJSON(...a: unknown[]) {
      return postJSONMock(...a);
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
  const VALID_STATUSES = ["unread", "read", "archived"];

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

  it("requires --agent_id, --to, --subject, --body-file", () => {
    const opts = (send as unknown as { options: { long: string; mandatory?: boolean }[] }).options;
    const mandatory = opts.filter((o) => o.mandatory).map((o) => o.long);
    expect(mandatory).toContain("--agent_id");
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
