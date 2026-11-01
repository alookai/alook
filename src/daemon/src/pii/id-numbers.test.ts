import { afterAll, expect, it } from "vitest";
import { PiiSnapshotSchema, PII_SOURCE_MAX_BYTES, PII_TEXT_MAX_BYTES } from "@alook/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiiStore } from "./store.js";
import { PII_DEFAULTS } from "./defaults.js";
import { compilePiiSource, PiiRunner } from "./evaluator.js";

const plugin = PII_DEFAULTS.find(plugin => plugin.id === "builtin.id-cards")!;
const runner = new PiiRunner();
const compiled = [{ id: plugin.id, code: compilePiiSource(plugin.source) }];
const marker = "[REDACTED_ID_CARD]";
const filter = (text: string) => runner.evaluate(compiled, text);
afterAll(() => runner.close());

const cases = [
  ["CN", "11010519491231002X", "110105194912310020"],
  ["HK", "A123456(3)", "A123456(8)"],
  ["HK two letters", "AB123456(9)", "AB123456(8)"],
  ["TW", "A123456789", "A123456788"],
  ["ES DNI", "12345678Z", "12345678A"],
  ["ES NIE", "X1234567L", "X1234567A"],
  ["IT CF", "RSSMRA85T10A562S", "RSSMRA85T10A562A"],
  ["US", "SSN: 219-09-9999", "SSN: 666-09-9999"],
  ["CA", "SIN: 123-456-782", "SIN: 123-456-783"],
  ["UK", "NINO: AB 12 34 56 C", "NINO: BG 12 34 56 C"],
  ["DE tax", "Steuer-ID: 36574261809", "Steuer-ID: 36574261890"],
  ["DE card", "Personalausweis: L01X00T47", "Personalausweis: A01X00T47"],
  ["FR NIR", "NIR: 1 84 12 76 451 089 46", "NIR: 1 84 12 76 451 089 45"],
  ["FR Corsica A", "NIR: 180062A12345603", "NIR: 180062A12345604"],
  ["FR Corsica B", "NIR: 180062B12345630", "NIR: 180062B12345631"],
  ["FR old card", "CNI: 990112345678", "CNI: 9901123456789"],
  ["FR new card", "CNI: A1B2C3D4E", "CNI: A1B2C3D4"],
  ["IT card", "CIE: CA12345AA", "CIE: CA1234AA"],
  ["IN", "Aadhaar: 2345 6789 0124", "Aadhaar: 2345 6789 0125"],
  ["JP", "My Number: 6214 9832 0257", "My Number: 6214 9832 0258"],
  ["KR", "RRN: 850102-1234567", "RRN: 850230-1234567"],
  ["KR foreign", "외국인등록번호: 000229-7123456", "외국인등록번호: 000230-7123456"],
  ["SG", "NRIC: S1234567D", "NRIC: S123456D"],
  ["SG M FIN", "FIN: M1234567B", "FIN: M1234567BB"],
  ["AU", "TFN: 876 543 210", "TFN: 876 543 211"],
  ["BR", "CPF: 280.012.389-38", "CPF: 280.012.389-39"],
] as const;

it.each(cases)("redacts %s and preserves its invalid counterpart", async (_name, positive, negative) => {
  const prefix = positive.slice(0, positive.lastIndexOf(":") + 1);
  expect(await filter(positive)).toBe(prefix ? `${prefix} ${marker}` : marker);
  expect(await filter(negative)).toBe(negative);
});

it("keeps the existing node and replacement IDs within the persisted/isolated contract", () => {
  expect(plugin.name).toBe("ID numbers");
  expect(Buffer.byteLength(plugin.source)).toBeLessThanOrEqual(PII_SOURCE_MAX_BYTES);
  expect(PiiSnapshotSchema.safeParse({ revision: 0, plugins: PII_DEFAULTS.map(({ source: _source, ...item }) => ({ ...item, enabled: true })) }).success).toBe(true);
});

it.each([
  ['{"ssn": "219099999"}', `{"ssn": "${marker}"}`],
  ["'SiN': '123456782'", `'SiN': '${marker}'`],
  ["social_security_number=219099999", `social_security_number=${marker}`],
  ["Numéro d'assurance sociale: 123456782", `Numéro d'assurance sociale: ${marker}`],
  ["国民の個人番号：621498320257", `国民の個人番号：${marker}`],
  ["マイナンバー 621498320257", `マイナンバー ${marker}`],
  ["주민등록번호: 8501021234567", `주민등록번호: ${marker}`],
  ["numéro de sécurité sociale: 184127645108946", `numéro de sécurité sociale: ${marker}`],
  ["Steueridentifikationsnummer 36574261809", `Steueridentifikationsnummer ${marker}`],
  ["आधार संख्या: 234567890124", `आधार संख्या: ${marker}`],
  ["CNI n°: A1B2C3D4E", `CNI n°: ${marker}`],
  ["IdNr.: 36 574 261 809", `IdNr.: ${marker}`],
  ["Steuer-ID: 65929970489", `Steuer-ID: ${marker}`],
  ["a123456(3), 12345678z.", `${marker}, ${marker}.`],
])("recognizes labeled, JSON, local-language and case variants: %s", async (input, output) => {
  expect(await filter(input)).toBe(output);
});

it.each([
  "order: 219099999", "order: 123456782", "order: 36574261809", "order: 184127645108946",
  "order: 234567890124", "order: 621498320257", "order: 8501021234567", "order: 876543210", "order: 28001238938",
  "SKU AB123456C", "SKU S1234567D", "SKU M1234567B", "SKU L01X00T47", "SKU A1B2C3D4E", "SKU CA12345AA",
  "other_ssn: 219099999", "notssn: 219099999", "SSNish: 219099999", "ssn:\n219099999",
  `ssn:${" ".repeat(100)}219099999`, `other_ssn:${" ".repeat(92)}219099999`, "SSN: order 219099999", "id: 219099999",
  "SSN: 000-09-9999", "SSN: 900-09-9999", "SSN: 219-00-9999", "SSN: 219-09-0000", "SSN: 111-11-1111",
  "CN 11010519490231002X", "CN 11010519000229002X", "RSSMRA85T40A562S",
  "Steuer-ID: 11123456789", "Steuer-ID: 36554266806",
  "SIN: 823456785", "NINO: QQ123456C", "NINO: AO123456C", "NINO: AB123456E",
  "Aadhaar: 123456789010", "My Number: 000000000000", "TFN: 000000000", "CPF: 111.111.111-11",
  "RRN: 000229-1123456", "RRN: 850102-9234567", "NIR: 1 84 13 76 451 089 35", "NIR: 1841276451089",
  "x11010519491231002X", "11010519491231002Xy", "x_12345678Z", "12345678Z_y",
  "order-12345678Z", "12345678Z-part", "/files/12345678Z/data", "12345678Z.json",
  "SSN: 12190999990", "SIN: 0123456782", "00000000-0000-0000-0000-123456782000",
  "aabbccdd11010519491231002Xaabbccdd", "SSN: 219-09-9999-01", "SIN: 123 456 782 9", "TFN: 876 543 210 9",
])("preserves non-IDs, invalid structure and token/label boundaries: %s", async input => {
  expect(await filter(input)).toBe(input);
});

it("handles a multi-country message and maximum-size adversarial numeric input inside the real QuickJS budget", async () => {
  const input = 'SSN: 219099999; SIN: 123456782; NINO: AB123456C; 12345678Z; My Number: 621498320257; CPF: 28001238938.';
  expect(await filter(input)).toBe(`SSN: ${marker}; SIN: ${marker}; NINO: ${marker}; ${marker}; My Number: ${marker}; CPF: ${marker}.`);
  for (const input of ["9".repeat(PII_TEXT_MAX_BYTES), "A".repeat(PII_TEXT_MAX_BYTES), "1234 ".repeat(204)]) {
    expect(await filter(input)).toBe(input);
  }
});


it("preserves unlabeled ordinary references through the entire default filter chain, while redacting labeled IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pii-id-chain-"));
  const store = new PiiStore(directory);
  try {
    expect(await filter("13800138018")).toBe("13800138018");
    expect(await store.filter("a", "13800138018")).toBe("[REDACTED_PHONE]");
    expect(await store.filter("a", "CPF: 13800138018")).toBe(`CPF: ${marker}`);
    const input = "orders: 219099999, 123456782, 36574261809, 184127645108946, 234567890124, 621498320257, 8501021234567, 876543210, 28001238938.";
    expect(await store.filter("a", input)).toBe(input);
    const mixed = 'SSN: 219099999; SIN: 123456782; NINO: AB123456C; 12345678Z; My Number: 621498320257; CPF: 28001238938; order 219099999.';
    const output = `SSN: ${marker}; SIN: ${marker}; NINO: ${marker}; ${marker}; My Number: ${marker}; CPF: ${marker}; order 219099999.`;
    expect(await store.filter("a", mixed)).toBe(output);
    expect(await store.manage("a", { action: "preview", text: mixed, expectedRevision: 0 }))
      .toMatchObject({ status: "complete", output });
    await store.manage("a", { action: "setEnabled", pluginId: plugin.id, enabled: false, expectedRevision: 0 });
    expect(await store.filter("a", mixed)).toBe(mixed);
    await store.manage("a", { action: "remove", pluginId: plugin.id, expectedRevision: 1 });
    expect(await store.filter("a", mixed)).toBe(mixed);
    expect(await store.filter("a", "phone: 13800138000; card: 4111 1111 1111 1111")).toBe("phone: [REDACTED_PHONE]; card: [REDACTED_BANK_CARD]");
  } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("keeps initialized rule copies, flags, custom nodes and order unchanged on restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pii-id-existing-"));
  const store = new PiiStore(directory);
  let restarted: PiiStore | undefined;
  try {
    await store.local("a", { action: "add", name: "custom", description: "retained fixture", source: 'export default (text: string) => text.replaceAll("project-private", "[CUSTOM]");' });
    await store.manage("a", { action: "setEnabled", pluginId: "builtin.emails", enabled: false, expectedRevision: 1 });
    const file = join(directory, "a", "pii", "pipelines.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const idNode = saved.plugins.find((item: { id: string }) => item.id === plugin.id);
    idNode.name = "Chinese ID cards";
    idNode.description = "An already initialized local source copy";
    idNode.source = 'export default (text: string) => text;';
    const bytes = JSON.stringify(saved);
    writeFileSync(file, bytes);
    restarted = new PiiStore(directory);
    expect(restarted.list("a").plugins.map(item => [item.id, item.enabled])).toEqual(saved.plugins.map((item: { id: string; enabled: boolean }) => [item.id, item.enabled]));
    expect(restarted.list("a").plugins.find(item => item.id === plugin.id)?.name).toBe("Chinese ID cards");
    expect(await restarted.filter("a", "SSN: 219099999 project-private person@company.cn")).toBe("SSN: 219099999 [CUSTOM] person@company.cn");
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(restarted.list("fresh").plugins.find(item => item.id === plugin.id)?.name).toBe("ID numbers");
    expect(await restarted.filter("fresh", "SSN: 219099999")).toBe(`SSN: ${marker}`);
  } finally { await restarted?.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
