import { afterAll, afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PII_SOURCE_MAX_BYTES } from "@alook/shared";
import { PII_DEFAULTS } from "./defaults.js";
import { compilePiiSource, PiiRunner } from "./evaluator.js";
import { PiiStore } from "./store.js";

const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy-credentials.json", import.meta.url), "utf8")) as { id: string; name: string; description: string; source: string; enabled: boolean }[];
const definition = PII_DEFAULTS[0];
const runner = new PiiRunner();
const directories: string[] = [];
const stores: PiiStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});

const cases: [string, string, string][] = [
  ["PEM", "before -----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY----- after", "before [REDACTED_PRIVATE_KEY] after"],
  ["encrypted PEM", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nopaque material\n-----END ENCRYPTED PRIVATE KEY-----", "[REDACTED_PRIVATE_KEY]"],
  ["PGP", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nopaque material\n-----END PGP PRIVATE KEY BLOCK-----", "[REDACTED_PRIVATE_KEY]"],
  ["API key", `key sk-${"a".repeat(24)}.`, "key [REDACTED_API_KEY]."],
  ["Alook credential", `credential vch_${"a".repeat(24)}`, "credential [REDACTED_API_KEY]"],
  ["JWT", `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`, "[REDACTED_TOKEN]"],
  ["Bearer", "Authorization: Bearer synthetic-token", "Authorization: Bearer [REDACTED_TOKEN]"],
  ["Basic", "Authorization: Basic YWJjOmRlZg==", "Authorization: Basic [REDACTED_TOKEN]"],
  ["password", 'DB_PASSWORD="aB12345678"', 'DB_PASSWORD="[REDACTED_SECRET]"'],
  ["secret", "client_secret=aB12345678", "client_secret=[REDACTED_SECRET]"],
  ["connection password", "postgres://user:pass1234@host/db", "postgres://user:[REDACTED_PASSWORD]@host/db"],
  ["API assignment overlap", `api_key=sk-${"a".repeat(24)}`, "api_key=[REDACTED_API_KEY]"],
  ["Bearer API overlap", `Bearer sk-${"a".repeat(24)}`, "Bearer [REDACTED_API_KEY]"],
  ["private block overlap", `-----BEGIN RSA PRIVATE KEY-----\nBearer sk-${"a".repeat(24)}\n-----END RSA PRIVATE KEY-----`, "[REDACTED_PRIVATE_KEY]"],
];

const run = (source: string, text: string) => runner.evaluate([{ id: "fixture", code: compilePiiSource(source) }], text);

it("initializes five real filters with one bounded credential source at the original first position", () => {
  expect(PII_DEFAULTS.map(plugin => plugin.id)).toEqual(["builtin.secrets", "builtin.emails", "builtin.id-cards", "builtin.phones", "builtin.bank-cards"]);
  expect(definition.name).toBe("Keys");
  expect(Buffer.byteLength(definition.source)).toBeLessThanOrEqual(PII_SOURCE_MAX_BYTES);
});

it.each(cases)("preserves the original %s detection and replacement marker", async (_label, input, output) => {
  expect(await run(definition.source, input)).toBe(output);
});

it("matches the legacy four-node sequence for mixed, overlapping and unrelated text, including maximum input", async () => {
  const previous = legacy.map(plugin => ({ id: plugin.id, code: compilePiiSource(plugin.source) }));
  const merged = [{ id: definition.id, code: compilePiiSource(definition.source) }];
  const negatives = ["a public key", "sk-short", "a bearer of news", "token_id=abc123456789", "process.env.ACCESS_TOKEN", "password=process.env.DATABASE_PASSWORD", "secret=os.environ", "password=1234567890", "order=abc123456789", `[REDACTED_PRIVATE_KEY] [REDACTED_API_KEY] [REDACTED_TOKEN] [REDACTED_PASSWORD] [REDACTED_SECRET]`];
  const mixed = cases.map(([, input]) => input).join("; ");
  const inputs = [...negatives, mixed, " ".repeat(65536 - mixed.length - 1) + " " + mixed];
  for (const input of inputs) {
    const output = await runner.evaluate(merged, input);
    expect(output).toBe(await runner.evaluate(previous, input));
    expect(await runner.evaluate(merged, output)).toBe(output);
  }
  for (const input of negatives) expect(await runner.evaluate(merged, input)).toBe(input);
});

it("disables or removes all four credential classes together while preserving other and custom rules", async () => {
  const path = mkdtempSync(join(tmpdir(), "pii-merged-controls-")); directories.push(path);
  const store = new PiiStore(path); stores.push(store);
  const input = cases.slice(0, 11).map(([, value]) => value).join("; ");
  const snapshot = await store.local("a", { action: "add", name: "project", description: "custom", source: 'export default (text: string) => text.replace("Project Wren", "[INTERNAL]");' });
  const enabled = await store.filter("a", input);
  expect(enabled).not.toBe(input);
  const disabled = await store.manage("a", { action: "setEnabled", pluginId: definition.id, enabled: false, expectedRevision: snapshot.revision });
  expect(disabled.status).toBe("complete");
  expect(await store.filter("a", input)).toBe(input);
  expect(await store.filter("a", "person@company.cn Project Wren")).toBe("[REDACTED_EMAIL] [INTERNAL]");
  const removed = await store.manage("a", { action: "remove", pluginId: definition.id, expectedRevision: snapshot.revision + 1 });
  expect(removed.status).toBe("complete");
  const restarted = new PiiStore(path); stores.push(restarted);
  expect(restarted.list("a").plugins.some(plugin => plugin.id === definition.id)).toBe(false);
  expect(await restarted.filter("a", input)).toBe(input);
  expect(await restarted.filter("a", "person@company.cn Project Wren")).toBe("[REDACTED_EMAIL] [INTERNAL]");
});

it("retains saved legacy sources, disabled and deleted rules and custom order without automatic consolidation", async () => {
  const path = mkdtempSync(join(tmpdir(), "pii-legacy-credentials-")); directories.push(path);
  const directory = join(path, "a", "pii"); mkdirSync(directory, { recursive: true });
  const plugins = [
    { ...legacy[0]!, enabled: false },
    legacy[2]!,
    { ...legacy[3]!, enabled: false },
    { id: "custom", name: "project", description: "custom", source: 'export default (text: string) => text.replace("Project Wren", "[INTERNAL]");', enabled: true },
    ...PII_DEFAULTS.slice(1).map(plugin => ({ ...plugin, enabled: true })),
  ];
  const file = join(directory, "pipelines.json"), bytes = JSON.stringify({ version: 1, revision: 42, plugins }); writeFileSync(file, bytes);
  const store = new PiiStore(path); stores.push(store);
  const snapshot = store.list("a");
  expect(snapshot.revision).toBe(42);
  expect(snapshot.plugins.map(({ id, enabled }) => ({ id, enabled }))).toEqual(plugins.map(({ id, enabled }) => ({ id, enabled })));
  const input = `-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY----- sk-${"a".repeat(24)} DB_PASSWORD=aB12345678 Authorization: Bearer synthetic-token Project Wren`;
  expect(await store.filter("a", input)).toBe(input.replace("synthetic-token", "[REDACTED_TOKEN]").replace("Project Wren", "[INTERNAL]"));
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

afterAll(async () => { await runner.close(); });
