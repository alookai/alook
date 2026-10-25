import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiiStore } from "./store.js";
import { compilePiiSource, evaluatePii } from "./evaluator.js";
import { PII_DEFAULTS } from "./defaults.js";

const directories: string[] = [];
const create = () => {
  const directory = mkdtempSync(join(tmpdir(), "pii-test-"));
  directories.push(directory);
  const path = join(directory, "pii");
  return { store: new PiiStore(path), path };
};
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("PII pipeline", () => {
  it("composes TS modules in order, isolates bots, skips disabled nodes and retains explicit deletion", async () => {
    const { store, path } = create();
    let snapshot = store.list("a");
    for (const plugin of snapshot.plugins) {
      const result = await store.manage("a", { action: "remove", pluginId: plugin.id, expectedRevision: snapshot.revision });
      if (result.status !== "complete") throw new Error("remove failed");
      snapshot = result.snapshot;
    }
    expect(new PiiStore(path).list("a").plugins).toEqual([]);
    expect(store.list("b").plugins).toHaveLength(8);
    snapshot = await store.local("a", { action: "add", name: "first", description: "replace seed", source: 'export default (text: string): string => text.replace("seed", "middle");' });
    snapshot = await store.local("a", { action: "add", name: "second", description: "replace middle", source: 'export default function(text: string): string { return text.replace("middle", "done"); }' });
    expect(await store.filter("a", "seed")).toBe("done");
    expect(await store.filter("b", "seed")).toBe("seed");
    expect(await store.manage("a", { action: "setEnabled", pluginId: snapshot.plugins[0]!.id, enabled: false, expectedRevision: snapshot.revision - 1 })).toMatchObject({ status: "error", code: "PII_CONFLICT", snapshot });
    expect(await store.manage("a", { action: "setEnabled", pluginId: snapshot.plugins[0]!.id, enabled: false, expectedRevision: snapshot.revision })).toMatchObject({ status: "complete" });
    expect(await new PiiStore(path).filter("a", "seed")).toBe("seed");
    expect(readFileSync(join(path, "pipelines.json"), "utf8")).toContain("export default");
    expect(snapshot.plugins[0]).not.toHaveProperty("source");
  });

  it("does not lose concurrent additions and does not accept invalid plugins", async () => {
    const { store } = create();
    const input = { action: "add" as const, name: "extra", description: "identity", source: 'export default (text: string) => text;' };
    await Promise.all([store.local("a", input), store.local("a", input)]);
    const snapshot = store.list("a");
    expect(snapshot.plugins).toHaveLength(10);
    expect(new Set(snapshot.plugins.map((plugin) => plugin.id)).size).toBe(10);
    for (const source of ['export default () => 1;', 'export default async () => "x";', 'export default () => process.env;', 'import fs from "node:fs"; export default () => fs.readFileSync("x");']) {
      await expect(store.local("a", { ...input, source })).rejects.toThrow(/^PII_/);
    }
    expect(store.list("a")).toEqual(snapshot);
  });

  it("previews the same ordered runner at a captured revision without persisting input, output or defaults", async () => {
    const { store, path } = create();
    const file = join(path, "pipelines.json");
    const pristine = readFileSync(file, "utf8");
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: 0 }))
      .toMatchObject({ status: "complete", output: "[REDACTED_EMAIL]", snapshot: { revision: 0 } });
    expect(readFileSync(file, "utf8")).toBe(pristine);
    const snapshot = await store.local("a", { action: "add", name: "last", description: "transform previous output", source: 'export default (text: string) => text.replace("[REDACTED_EMAIL]", "[FINAL]");' });
    const before = readFileSync(file, "utf8");
    const pending = store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision });
    const changed = await store.manage("a", { action: "setEnabled", pluginId: "builtin.emails", enabled: false, expectedRevision: snapshot.revision });
    expect(changed.status).toBe("complete");
    expect(await pending).toEqual({ status: "complete", output: "[FINAL]", snapshot });
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision }))
      .toMatchObject({ status: "error", code: "PII_CONFLICT", snapshot: { revision: snapshot.revision + 1 } });
    const after = readFileSync(file, "utf8");
    expect(after).not.toBe(before);
    expect(after).not.toContain("person@company.cn");
    expect(await store.manage("a", { action: "preview", text: "person@company.cn", expectedRevision: snapshot.revision + 1 }))
      .toMatchObject({ status: "complete", output: "person@company.cn" });
    expect(readFileSync(file, "utf8")).toBe(after);
  });

  it("previews empty chains and returns bounded safe failures with no state writes", async () => {
    const { store, path } = create();
    let snapshot = store.list("a");
    for (const plugin of snapshot.plugins) {
      const result = await store.manage("a", { action: "remove", pluginId: plugin.id, expectedRevision: snapshot.revision });
      if (result.status !== "complete") throw new Error("remove failed");
      snapshot = result.snapshot;
    }
    expect(await store.manage("a", { action: "preview", text: "unchanged", expectedRevision: snapshot.revision }))
      .toEqual({ status: "complete", output: "unchanged", snapshot });
    snapshot = await store.local("a", { action: "add", name: "fixture", description: "safe error fixtures", source: 'export default (text: string) => { if(!text)return text; if(text==="expand")return "中".repeat(400); if(text==="erase")return ""; if(text==="loop"){while(true){}} if(text==="number")return 1; throw new Error(text); };' });
    const before = readFileSync(join(path, "pipelines.json"), "utf8");
    for (const [text, code] of [["expand", "PII_OUTPUT_TOO_LARGE"], ["erase", "PII_INVALID_RESULT"], ["number", "PII_INVALID_RESULT"], ["loop", "PII_PLUGIN_FAILED"], ["private-error-text", "PII_PLUGIN_FAILED"]]) {
      const result = await store.manage("a", { action: "preview", text: text!, expectedRevision: snapshot.revision });
      expect(result).toMatchObject({ status: "error", code });
      expect(result).not.toHaveProperty("output");
      expect(JSON.stringify(result)).not.toContain(text);
    }
    expect(await store.manage("a", { action: "preview", text: "中".repeat(400), expectedRevision: snapshot.revision }))
      .toEqual({ status: "error", code: "PII_INVALID_REQUEST" });
    expect(readFileSync(join(path, "pipelines.json"), "utf8")).toBe(before);
  });

  it("fails closed on corrupt and missing established config", async () => {
    const { store, path } = create();
    store.list("a");
    writeFileSync(join(path, "pipelines.json"), "invalid");
    await expect(store.filter("a", "private input")).rejects.toThrow("PII_CONFIG_UNAVAILABLE");
    expect(await store.manage("a", { action: "list" })).toEqual({ status: "error", code: "PII_UNAVAILABLE" });
    rmSync(join(path, "pipelines.json"));
    expect(() => new PiiStore(path)).toThrow("PII_CONFIG_UNAVAILABLE");
  });

  it("bounds infinite loops, complex regular expressions and allocations without exposing raw exceptions", async () => {
    const sources = [
      'export default () => { while(true) {} };',
      'export default (text: string) => /^(a+)+$/.test(text) ? text : "no";',
      'export default () => "x".repeat(100000000);',
      'export default (text: string) => { throw new Error(text); };',
    ];
    for (const source of sources) {
      const started = Date.now();
      await expect(evaluatePii([{ id: "bounded", code: compilePiiSource(source) }], "a".repeat(100) + "!PRIVATE")).rejects.toThrow(/^PII_/);
      expect(Date.now() - started).toBeLessThan(4_000);
    }
    expect(await evaluatePii([{ id: "host", code: compilePiiSource('export default () => [typeof process,typeof require,typeof fetch,typeof Bun,typeof console].join(",");') }], "")).toBe("undefined,undefined,undefined,undefined,undefined");
  });
});

describe("default filter categories", () => {
  it("redacts email before sentence punctuation without taking the punctuation or matching filenames", async () => {
    const { store } = create();
    for (const punctuation of [".", "...", ".\nNext sentence", ",", "。", "，", ";", "!", "?"]) {
      expect(await store.filter("a", `Email me at lin@example.com${punctuation}`)).toBe(`Email me at [REDACTED_EMAIL]${punctuation}`);
    }
    expect(await store.filter("a", "image@2x.png. Notes follow.")).toBe("image@2x.png. Notes follow.");
  });
  const fixtures = [
    ["builtin.private-keys", "before -----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY----- after", "before [REDACTED_PRIVATE_KEY] after", "a public key"],
    ["builtin.api-keys", `key sk-${"a".repeat(24)}`, "key [REDACTED_API_KEY]", "sk-short"],
    ["builtin.tokens", "Authorization: Bearer synthetic-token", "Authorization: Bearer [REDACTED_TOKEN]", "a bearer of news"],
    ["builtin.secrets", 'DB_PASSWORD="aB12345678" postgres://u:pass1234@host/db', 'DB_PASSWORD="[REDACTED_SECRET]" postgres://u:[REDACTED_PASSWORD]@host/db', "token_id=abc123456789 process.env.ACCESS_TOKEN"],
    ["builtin.emails", "mail person@company.cn please", "mail [REDACTED_EMAIL] please", "@gus#1813 image@2x.png"],
    ["builtin.id-cards", "id 11010519491231002X", "id [REDACTED_ID_CARD]", "id 110105194912310021"],
    ["builtin.phones", "call +86 13800138000", "call [REDACTED_PHONE]", "prefix13800138000suffix"],
    ["builtin.bank-cards", "card 4111 1111 1111 1111", "card [REDACTED_BANK_CARD]", "4111 1111 1111 1112"],
  ];
  it.each(fixtures)("%s preserves surrounding and unrelated text", async (id, input, output, negative) => {
    const definition = PII_DEFAULTS.find((plugin) => plugin.id === id)!;
    const plugins = [{ id: definition.id, code: compilePiiSource(definition.source) }];
    expect(await evaluatePii(plugins, input!)).toBe(output);
    expect(await evaluatePii(plugins, negative!)).toBe(negative);
  });
  it("is idempotent and preserves UUIDs across nodes", async () => {
    const { store } = create();
    const input = "person@company.cn +86 13800138000 aaaa4111-1111-1111-9007-123456789012";
    const once = await store.filter("a", input);
    expect(once).toContain("aaaa4111-1111-1111-9007-123456789012");
    expect(await store.filter("a", once)).toBe(once);
  });
});
