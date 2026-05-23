import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, symlinkSync: vi.fn(actual.symlinkSync) };
});

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildInstructionContent,
  contentHash,
  hasContentChanged,
  ensureSymlinks,
  writeInstructionFileIfChanged,
  CANONICAL_FILE,
  SYMLINK_ALIASES,
} from "../context.js";
import type { Task } from "../../types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    agentId: "a1",
    runtimeId: "rt1",
    conversationId: "c1",
    workspaceId: "ws1",
    prompt: "do something",
    status: "running",
    priority: 0,
    createdAt: "2026-01-01T00:00:00Z",
    agent: { name: "test-agent", instructions: "Be helpful and concise." },
    ...overrides,
  };
}

describe("buildInstructionContent", () => {
  it("uses agent name in opening line when provided", () => {
    const task = makeTask({ agent: { name: "My Assistant", instructions: "" } });
    const content = buildInstructionContent(task);
    expect(content).toContain("You're My Assistant in the Alook Platform.");
  });

  it("falls back to 'Alook Agent' when agent is undefined", () => {
    const task = makeTask({ agent: undefined });
    const content = buildInstructionContent(task);
    expect(content).toContain("You're Alook Agent in the Alook Platform.");
  });

  it("includes agent email in opening line", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "", emailHandle: "aria" },
    });
    const content = buildInstructionContent(task);
    expect(content).toContain("You're Aria (aria@alook.ai) in the Alook Platform.");
  });

  it("omits email parenthetical when no email configured", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "" },
    });
    const content = buildInstructionContent(task);
    expect(content).toContain("You're Aria in the Alook Platform.");
    expect(content).not.toContain("You're Aria (");
  });

  it("includes owner name and email", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "", userName: "Gustavo", userEmail: "gus@example.com" },
    });
    const content = buildInstructionContent(task);
    expect(content).toContain("Your owner and creator is Gustavo (gus@example.com).");
  });

  it("includes owner email without name when name is not available", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "", userEmail: "gus@example.com" },
    });
    const content = buildInstructionContent(task);
    expect(content).toContain("Your owner and creator is (gus@example.com).");
  });

  it("omits owner sentence when no owner info available", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "" },
    });
    const content = buildInstructionContent(task);
    expect(content).not.toContain("owner and creator");
  });

  it("uses custom email address when no alook handle", () => {
    const task = makeTask({
      agent: { name: "Aria", instructions: "", emailAddresses: ["aria@company.com"] },
    });
    const content = buildInstructionContent(task);
    expect(content).toContain("You're Aria (aria@company.com) in the Alook Platform.");
  });
});

describe("contentHash", () => {
  it("returns consistent hex string for same input", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different hex strings for different inputs", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("world");
    expect(h1).not.toBe(h2);
  });
});

describe("hasContentChanged", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `execenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns true when file does not exist", () => {
    expect(hasContentChanged(join(workDir, "missing.md"), "content")).toBe(true);
  });

  it("returns false when file exists with identical content", () => {
    const filePath = join(workDir, "test.md");
    writeFileSync(filePath, "same content", "utf-8");
    expect(hasContentChanged(filePath, "same content")).toBe(false);
  });

  it("returns true when file exists with different content", () => {
    const filePath = join(workDir, "test.md");
    writeFileSync(filePath, "old content", "utf-8");
    expect(hasContentChanged(filePath, "new content")).toBe(true);
  });
});

describe("ensureSymlinks", () => {
  let workDir: string;

  beforeEach(() => {
    vi.mocked(symlinkSync).mockRestore();
    workDir = join(tmpdir(), `execenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    vi.mocked(symlinkSync).mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("creates CLAUDE.md symlink pointing to AGENTS.md", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("does not create symlink when canonical file doesn't exist", () => {
    ensureSymlinks(workDir);

    expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
  });

  it("replaces a regular file at alias path with a symlink", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    writeFileSync(join(workDir, "CLAUDE.md"), "old regular file", "utf-8");

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("replaces a symlink pointing to wrong target", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    writeFileSync(join(workDir, "WRONG.md"), "wrong", "utf-8");
    symlinkSync("WRONG.md", join(workDir, "CLAUDE.md"));

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("is no-op when correct symlink already exists", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    symlinkSync(CANONICAL_FILE, join(workDir, "CLAUDE.md"));

    // Should not throw
    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("falls back to file copy when symlinkSync throws EPERM", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "canonical content", "utf-8");
    vi.mocked(symlinkSync).mockImplementation(() => {
      const err = new Error("EPERM: operation not permitted, symlink") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isFile()).toBe(true);
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(aliasPath, "utf-8")).toBe("canonical content");
  });

  it("falls back to file copy when symlinkSync throws EACCES", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "canonical content", "utf-8");
    vi.mocked(symlinkSync).mockImplementation(() => {
      const err = new Error("EACCES: permission denied, symlink") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isFile()).toBe(true);
    expect(readFileSync(aliasPath, "utf-8")).toBe("canonical content");
  });

  it("re-throws non-EPERM/EACCES errors from symlinkSync", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    vi.mocked(symlinkSync).mockImplementation(() => {
      const err = new Error("EIO: i/o error, symlink") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });

    expect(() => ensureSymlinks(workDir)).toThrow("EIO");
  });

  it("existing regular file copy with matching content is left untouched", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "same content", "utf-8");
    writeFileSync(join(workDir, "CLAUDE.md"), "same content", "utf-8");
    const mtimeBefore = lstatSync(join(workDir, "CLAUDE.md")).mtimeMs;

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isFile()).toBe(true);
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(aliasPath, "utf-8")).toBe("same content");
    expect(lstatSync(aliasPath).mtimeMs).toBe(mtimeBefore);
  });

  it("existing regular file copy with stale content is refreshed", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "new content", "utf-8");
    writeFileSync(join(workDir, "CLAUDE.md"), "old content", "utf-8");
    vi.mocked(symlinkSync).mockImplementation(() => {
      const err = new Error("EPERM: operation not permitted, symlink") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(readFileSync(aliasPath, "utf-8")).toBe("new content");
  });

  it("transitions from symlink to copy when permissions change", () => {
    writeFileSync(join(workDir, CANONICAL_FILE), "content", "utf-8");
    // First call creates a real symlink (symlinkSync uses real implementation by default)
    ensureSymlinks(workDir);
    expect(lstatSync(join(workDir, "CLAUDE.md")).isSymbolicLink()).toBe(true);

    // Simulate permission loss — remove symlink and mock EPERM
    unlinkSync(join(workDir, "CLAUDE.md"));
    vi.mocked(symlinkSync).mockImplementation(() => {
      const err = new Error("EPERM: operation not permitted, symlink") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    ensureSymlinks(workDir);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isFile()).toBe(true);
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(aliasPath, "utf-8")).toBe("content");
  });
});

describe("writeInstructionFileIfChanged", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `execenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("writes AGENTS.md on first call (no prior file), returns true", () => {
    const task = makeTask();
    const result = writeInstructionFileIfChanged(workDir, task);

    expect(result).toBe(true);
    expect(existsSync(join(workDir, CANONICAL_FILE))).toBe(true);
    const content = readFileSync(join(workDir, CANONICAL_FILE), "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("creates CLAUDE.md symlink on first call", () => {
    const task = makeTask();
    writeInstructionFileIfChanged(workDir, task);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("returns false on second call with same task (no write)", () => {
    const task = makeTask();
    writeInstructionFileIfChanged(workDir, task);
    const result = writeInstructionFileIfChanged(workDir, task);

    expect(result).toBe(false);
  });

  it("returns true when instructions change between calls", () => {
    const task1 = makeTask({ agent: { name: "a", instructions: "Old" } });
    writeInstructionFileIfChanged(workDir, task1);

    const task2 = makeTask({ agent: { name: "a", instructions: "New" } });
    const result = writeInstructionFileIfChanged(workDir, task2);

    expect(result).toBe(true);
    const content = readFileSync(join(workDir, CANONICAL_FILE), "utf-8");
    expect(content).toContain("New");
    expect(content).not.toContain("Old");
  });

  it("preserves symlinks on subsequent no-change calls", () => {
    const task = makeTask();
    writeInstructionFileIfChanged(workDir, task);
    writeInstructionFileIfChanged(workDir, task);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });

  it("replaces a stale regular CLAUDE.md file with a symlink", () => {
    writeFileSync(join(workDir, "CLAUDE.md"), "stale regular file", "utf-8");
    const task = makeTask();
    writeInstructionFileIfChanged(workDir, task);

    const aliasPath = join(workDir, "CLAUDE.md");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(aliasPath)).toBe(CANONICAL_FILE);
  });
});
