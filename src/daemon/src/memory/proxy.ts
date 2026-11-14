import type { IncomingMessage, ServerResponse } from "node:http";
import { MEMORY_COMMIT_MAX_BYTES, validateMemoryCommit } from "./commit.js";

export interface LocalCommitResult {
  no: number;
  reset: boolean;
  resetSession?: () => Promise<void>;
}

export async function handleLocalMemoryCommit(
  req: IncomingMessage,
  res: ServerResponse,
  identity: { agentId: string; launchId: string },
  commit: ((identity: { agentId: string; launchId: string }, input: { log: string; reset: boolean }) => LocalCommitResult) | undefined,
  onResetError?: (agentId: string, error: unknown) => void,
): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (!commit) throw new Error("commit: daemon is not ready");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MEMORY_COMMIT_MAX_BYTES * 6 + 256) throw new Error("commit: request too large");
      chunks.push(bytes);
    }
    const input = validateMemoryCommit(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (res.destroyed) return;
    const result = commit(identity, input);
    if (result.resetSession) {
      // The CLI flushes stdout and exits before closing its keep-alive socket.
      // Do not stop its owning session until that connection has closed.
      req.socket.once("close", () => {
        if (!res.writableFinished) return;
        void result.resetSession!().catch((error) => onResetError?.(identity.agentId, error));
      });
    }
    json(200, { committed: true, no: result.no, reset: result.reset });
  } catch (error) {
    if (!res.destroyed) json(400, { error: error instanceof Error ? error.message : String(error) });
  }
}
