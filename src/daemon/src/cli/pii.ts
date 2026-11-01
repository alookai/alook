import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import { PII_SOURCE_MAX_BYTES, PiiSnapshotSchema } from "@alook/shared";
import { LOCAL_PII_PATH } from "../pii/proxy.js";

export function registerPiiCommands(program: Command, output: (value: { success: unknown }) => void) {
  const pii = program.command("pii").description("local outgoing message text filters; list or append a TypeScript plugin").exitOverride();
  const request = async (input?: { action: "add"; name: string; description: string; source: string }) => {
    const url = process.env.ALOOK_PROXY_URL;
    const tokenFile = process.env.ALOOK_PROXY_TOKEN_FILE;
    if (!url || !tokenFile) throw new Error("PII requires the running bot's local daemon proxy");
    const response = await fetch(`${url.replace(/\/+$/, "")}${LOCAL_PII_PATH}`, {
      method: input ? "POST" : "GET",
      headers: { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`, "content-type": "application/json" },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : "PII_UNAVAILABLE";
      throw Object.assign(new Error(code), { code });
    }
    output({ success: PiiSnapshotSchema.parse(body) });
  };
  pii.command("list").description("show this bot's filters in execution order").exitOverride().action(() => request());
  const add = pii.command("add").description("append a pure synchronous TS function returning { text, triggered: boolean }").exitOverride()
    .requiredOption("--file <path>", "local TypeScript module; imports and host APIs are unavailable")
    .requiredOption("--description <text>", "one sentence describing this filter");
  add.action(async () => {
    const options = add.opts<{ file: string; description: string }>();
    if (statSync(options.file).size > PII_SOURCE_MAX_BYTES) throw new Error("PII_SOURCE_TOO_LARGE");
    await request({ action: "add", name: basename(options.file, extname(options.file)), description: options.description, source: readFileSync(options.file, "utf8") });
  });
}
