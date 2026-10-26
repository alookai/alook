import type { IncomingMessage, ServerResponse } from "node:http";
import { CommunityAgentSendRequestSchema, PiiLocalRequestSchema, PII_TEXT_MAX_BYTES } from "@alook/shared";
import type { PiiStore } from "./store.js";
import { PiiError } from "./evaluator.js";

export const LOCAL_PII_PATH = "/__alook/local/pii";
export type PiiProxy = Pick<PiiStore, "filterWithResult" | "local">;

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")
    || (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
    request.resume();
    throw new PiiError("PII_INVALID_REQUEST");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.resume();
      reject(new PiiError("PII_INVALID_REQUEST"));
    };
    const timer = setTimeout(fail, 3_000);
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) fail();
      else if (!finished) chunks.push(chunk);
    });
    request.on("error", fail);
    request.on("aborted", fail);
    request.on("end", () => {
      if (finished) return;
      clearTimeout(timer);
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
        finished = true;
        resolve(value as Record<string, unknown>);
      } catch { fail(); }
    });
  });
}

export function writePiiError(response: ServerResponse, error: unknown): void {
  const safe = error instanceof PiiError ? error : new PiiError("PII_UNAVAILABLE");
  response.writeHead(422, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: safe.message, code: safe.code, ...(safe.pluginId ? { pluginId: safe.pluginId } : {}) }));
}

export async function handleLocalPii(request: IncomingMessage, response: ServerResponse, botId: string, pii?: PiiProxy): Promise<void> {
  try {
    if (!pii) throw new PiiError("PII_UNAVAILABLE");
    const input = request.method === "GET" ? { action: "list" } : await readJson(request);
    const parsed = PiiLocalRequestSchema.safeParse(input);
    if (!parsed.success) throw new PiiError("PII_INVALID_REQUEST");
    const snapshot = await pii.local(botId, parsed.data);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(snapshot));
  } catch (error) { writePiiError(response, error); }
}

export async function filterPiiRequest(request: IncomingMessage, botId: string, pii: PiiProxy): Promise<{ body: Buffer; triggeredFilters: { id: string; name: string }[] }> {
  const body = await readJson(request);
  const content = body.content;
  if (!content || typeof content !== "object" || Array.isArray(content)
    || ((content as { text?: unknown }).text !== undefined && typeof (content as { text?: unknown }).text !== "string")) {
    throw new PiiError("PII_INVALID_REQUEST");
  }
  const { text, triggeredFilters } = await pii.filterWithResult(botId, (content as { text?: string }).text ?? "");
  if (Buffer.byteLength(text, "utf8") > PII_TEXT_MAX_BYTES) throw new PiiError("PII_OUTPUT_TOO_LARGE");
  body.content = { ...content, text };
  if (!CommunityAgentSendRequestSchema.safeParse(body).success) throw new PiiError("PII_INVALID_RESULT");
  return { body: Buffer.from(JSON.stringify(body)), triggeredFilters };
}


export function forwardPiiSendResponse(upstream: IncomingMessage, response: ServerResponse, triggeredFilters: { id: string; name: string }[]): void {
  const chunks: Buffer[] = [];
  let bytes = 0, streaming = false;
  const write = (chunk: Buffer) => {
    if (!response.write(chunk)) {
      upstream.pause();
      response.once("drain", () => upstream.resume());
    }
  };
  upstream.on("data", (chunk: Buffer) => {
    if (streaming) { write(chunk); return; }
    chunks.push(Buffer.from(chunk));
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024) {
      streaming = true;
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      chunks.forEach(write);
      chunks.length = 0;
    }
  });
  upstream.on("end", () => {
    if (streaming) { response.end(); return; }
    const body = Buffer.concat(chunks);
    let output = body;
    try {
      const value: unknown = JSON.parse(body.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)
        && (value as { state?: unknown }).state === "sent"
        && (value as { message?: unknown }).message && typeof (value as { message: unknown }).message === "object"
        && typeof (value as { message: { channel?: unknown } }).message.channel === "string"
        && typeof (value as { message: { seq?: unknown } }).message.seq === "string") {
        output = Buffer.from(JSON.stringify({ ...value, pii: { triggeredFilters } }));
      }
    } catch {}
    const headers = { ...upstream.headers };
    if (output !== body) {
      delete headers["transfer-encoding"];
      delete headers.etag;
      headers["content-length"] = String(output.byteLength);
    }
    response.writeHead(upstream.statusCode ?? 502, headers);
    response.end(output);
  });
}
