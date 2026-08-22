import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeAgentFile, ensureSymlinks, CANONICAL_FILE, SYMLINK_ALIASES } from "./agentFile.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentFile-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeAgentFile", () => {
  it("writes AGENTS.md and creates CLAUDE.md symlink", () => {
    writeAgentFile(tmpDir, "hello prompt");
    expect(fs.readFileSync(path.join(tmpDir, CANONICAL_FILE), "utf-8")).toBe("hello prompt");
    const link = fs.readlinkSync(path.join(tmpDir, SYMLINK_ALIASES[0]));
    expect(link).toBe(CANONICAL_FILE);
  });

  it("returns true on first write, false when unchanged", () => {
    expect(writeAgentFile(tmpDir, "content")).toBe(true);
    expect(writeAgentFile(tmpDir, "content")).toBe(false);
  });

  it("returns true and overwrites when content changes", () => {
    writeAgentFile(tmpDir, "v1");
    expect(writeAgentFile(tmpDir, "v2")).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, CANONICAL_FILE), "utf-8")).toBe("v2");
  });

  it("fixes a stale symlink pointing elsewhere", () => {
    fs.writeFileSync(path.join(tmpDir, CANONICAL_FILE), "content");
    fs.symlinkSync("wrong-target.md", path.join(tmpDir, SYMLINK_ALIASES[0]));
    writeAgentFile(tmpDir, "content");
    const link = fs.readlinkSync(path.join(tmpDir, SYMLINK_ALIASES[0]));
    expect(link).toBe(CANONICAL_FILE);
  });

  it("replaces a regular CLAUDE.md that differs from AGENTS.md", () => {
    fs.writeFileSync(path.join(tmpDir, SYMLINK_ALIASES[0]), "old content");
    writeAgentFile(tmpDir, "new content");
    const stat = fs.lstatSync(path.join(tmpDir, SYMLINK_ALIASES[0]));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(tmpDir, SYMLINK_ALIASES[0]))).toBe(CANONICAL_FILE);
  });

  it("materializes the adapter's declared canonical file and aliases", () => {
    writeAgentFile(tmpDir, "custom", { canonical: "SYSTEM.md", aliases: ["BOT.md", "CLAUDE.md"] });
    expect(fs.readFileSync(path.join(tmpDir, "SYSTEM.md"), "utf8")).toBe("custom");
    expect(fs.readlinkSync(path.join(tmpDir, "BOT.md"))).toBe("SYSTEM.md");
    expect(fs.readlinkSync(path.join(tmpDir, "CLAUDE.md"))).toBe("SYSTEM.md");
  });

  it("rejects adapter-declared instruction paths that escape the workspace", () => {
    expect(() => writeAgentFile(tmpDir, "unsafe", { canonical: "../outside.md", aliases: [] }))
      .toThrow("plain workspace basenames");
    expect(fs.existsSync(path.join(tmpDir, "..", "outside.md"))).toBe(false);
  });
});

describe("ensureSymlinks", () => {
  it("does nothing when AGENTS.md does not exist", () => {
    ensureSymlinks(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, SYMLINK_ALIASES[0]))).toBe(false);
  });

  it("leaves existing correct symlink alone", () => {
    fs.writeFileSync(path.join(tmpDir, CANONICAL_FILE), "test");
    fs.symlinkSync(CANONICAL_FILE, path.join(tmpDir, SYMLINK_ALIASES[0]));
    ensureSymlinks(tmpDir);
    expect(fs.readlinkSync(path.join(tmpDir, SYMLINK_ALIASES[0]))).toBe(CANONICAL_FILE);
  });
});
