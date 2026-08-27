import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fillEmptyKey, generateDevVars, readKey } from "../generate-dev-vars.mjs"

const repoRoot = resolve(import.meta.dirname, "../..")

const sandboxes: string[] = []

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "alook-dev-vars-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "web"), { recursive: true });
  mkdirSync(join(dir, "email"), { recursive: true });
  return {
    webVars: join(dir, "web/.dev.vars"),
    webExample: join(dir, "web/.dev.vars.example"),
    emailVars: join(dir, "email/.dev.vars"),
    emailExample: join(dir, "email/.dev.vars.example"),
  };
}

function copyRealExamples(paths: ReturnType<typeof makeSandbox>) {
  writeFileSync(paths.webExample, readFileSync(join(repoRoot, "src/web/.dev.vars.example")));
  writeFileSync(paths.emailExample, readFileSync(join(repoRoot, "src/email-worker/.dev.vars.example")));
}

afterEach(() => {
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

describe("fillEmptyKey", () => {
  it("fills only the exact empty assignment line", () => {
    const content = "ENCRYPTION_KEY=\nENCRYPTION_KEY_URL=x\nOTHER=y\nENCRYPTION_KEY=kept\n";
    const filled = fillEmptyKey(content, "ENCRYPTION_KEY", "abc");
    expect(filled).toBe("ENCRYPTION_KEY=abc\nENCRYPTION_KEY_URL=x\nOTHER=y\nENCRYPTION_KEY=kept\n");
  });

  it("leaves content unchanged when no empty assignment exists", () => {
    const content = "ENCRYPTION_KEY=already-set\n";
    expect(fillEmptyKey(content, "ENCRYPTION_KEY", "abc")).toBe(content);
  });
});

describe("readKey", () => {
  it("reads the value including base64 padding", () => {
    expect(readKey("ENCRYPTION_KEY=abc/def+x==\n", "ENCRYPTION_KEY")).toBe("abc/def+x==");
  });

  it("returns an empty string when the key is absent", () => {
    expect(readKey("OTHER=1\n", "ENCRYPTION_KEY")).toBe("");
  });
});

describe("generateDevVars", () => {
  it("generates web vars with both secrets filled and other keys left empty", () => {
    const paths = makeSandbox();
    copyRealExamples(paths);
    generateDevVars(paths);
    const content = readFileSync(paths.webVars, "utf8");
    expect(readKey(content, "BETTER_AUTH_SECRET")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(readKey(content, "ENCRYPTION_KEY")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(readKey(content, "GITHUB_CLIENT_ID")).toBe("");
    expect(readKey(content, "DEVICE_CLIENT_IDS")).toBe("alook-cli");
  });

  it("syncs the email worker key from the web vars", () => {
    const paths = makeSandbox();
    copyRealExamples(paths);
    generateDevVars(paths);
    const web = readFileSync(paths.webVars, "utf8");
    const email = readFileSync(paths.emailVars, "utf8");
    expect(readKey(email, "ENCRYPTION_KEY")).toBe(readKey(web, "ENCRYPTION_KEY"));
    expect(readKey(email, "ENCRYPTION_KEY")).not.toBe("");
  });

  it("skips generation when both files already exist", () => {
    const paths = makeSandbox();
    copyRealExamples(paths);
    writeFileSync(paths.webVars, "ENCRYPTION_KEY=existing\n");
    writeFileSync(paths.emailVars, "ENCRYPTION_KEY=existing\n");
    generateDevVars(paths);
    expect(readFileSync(paths.webVars, "utf8")).toBe("ENCRYPTION_KEY=existing\n");
    expect(readFileSync(paths.emailVars, "utf8")).toBe("ENCRYPTION_KEY=existing\n");
  });
});
