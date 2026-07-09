/**
 * Filesystem Mailbox — IPC between daemon and session-runner for steering.
 *
 * Protocol:
 * 1. Daemon atomically writes <seq>.json.tmp → renames to <seq>.json
 * 2. Session-runner watches inbox via fs.watch() + polling fallback
 * 3. Session-runner reads file, delivers to agent stdin
 * 4. Session-runner writes <seq>.ack (or <seq>.nack with reason)
 * 5. Daemon polls for ack within timeout, falls back on nack/timeout
 */

import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, unlinkSync, rmSync, existsSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "mailbox" });

export interface SteerMessage {
  taskId: string;
  text: string;
  attachments: { localPath: string; filename: string; contentType: string }[];
  createdAt: string;
}

interface NackPayload {
  reason: string;
}

// --- Directory structure helpers ---

export function inboxDir(baseDir: string, contextKey: string): string {
  const safeKey = contextKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(baseDir, ".steering", safeKey, "inbox");
}

function ackDir(baseDir: string, contextKey: string): string {
  const safeKey = contextKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(baseDir, ".steering", safeKey, "ack");
}

function steeringDir(baseDir: string, contextKey: string): string {
  const safeKey = contextKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(baseDir, ".steering", safeKey);
}

// --- Daemon side (writer) ---

export function ensureMailboxDirs(baseDir: string, contextKey: string): void {
  const inbox = inboxDir(baseDir, contextKey);
  const ack = ackDir(baseDir, contextKey);
  mkdirSync(inbox, { recursive: true });
  mkdirSync(ack, { recursive: true });
}

let seqCounter = 0;

export function writeSteerMessage(baseDir: string, contextKey: string, message: SteerMessage): string {
  const inbox = inboxDir(baseDir, contextKey);
  const seq = String(++seqCounter).padStart(6, "0");
  const tmpPath = join(inbox, `${seq}.json.tmp`);
  const finalPath = join(inbox, `${seq}.json`);
  writeFileSync(tmpPath, JSON.stringify(message));
  renameSync(tmpPath, finalPath);
  return seq;
}

export function waitForAck(
  baseDir: string,
  contextKey: string,
  seq: string,
  timeoutMs: number = 3000,
): Promise<{ acked: boolean; nackReason?: string }> {
  const ackPath = join(ackDir(baseDir, contextKey), `${seq}.ack`);
  const nackPath = join(ackDir(baseDir, contextKey), `${seq}.nack`);

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 100;

    const check = () => {
      try {
        if (existsSync(ackPath)) {
          resolve({ acked: true });
          return;
        }
        if (existsSync(nackPath)) {
          let reason = "unknown";
          try {
            const content = readFileSync(nackPath, "utf-8");
            const parsed = JSON.parse(content) as NackPayload;
            reason = parsed.reason || "unknown";
          } catch { /* best-effort */ }
          resolve({ acked: false, nackReason: reason });
          return;
        }
      } catch { /* best-effort */ }

      if (Date.now() >= deadline) {
        resolve({ acked: false, nackReason: "timeout" });
        return;
      }
      setTimeout(check, pollInterval);
    };
    check();
  });
}

// --- Session-runner side (reader) ---

function readSteerMessage(filePath: string): SteerMessage | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as SteerMessage;
  } catch {
    return null;
  }
}

export function writeAck(baseDir: string, contextKey: string, seq: string): void {
  const ack = ackDir(baseDir, contextKey);
  mkdirSync(ack, { recursive: true });
  writeFileSync(join(ack, `${seq}.ack`), "");
}

export function writeNack(baseDir: string, contextKey: string, seq: string, reason: string): void {
  const ack = ackDir(baseDir, contextKey);
  mkdirSync(ack, { recursive: true });
  writeFileSync(join(ack, `${seq}.nack`), JSON.stringify({ reason }));
}

export function cleanupInboxFile(baseDir: string, contextKey: string, seq: string): void {
  try {
    unlinkSync(join(inboxDir(baseDir, contextKey), `${seq}.json`));
  } catch { /* best-effort */ }
}

export function cleanupSteeringDir(baseDir: string, contextKey: string): void {
  const dir = steeringDir(baseDir, contextKey);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

export interface MailboxWatcher {
  stop(): void;
}

/**
 * Watch the inbox directory for new steer messages.
 * Calls onMessage for each new .json file detected.
 * Uses fs.watch + polling fallback for reliability.
 */
export function watchInbox(
  baseDir: string,
  contextKey: string,
  onMessage: (seq: string, message: SteerMessage) => void,
): MailboxWatcher {
  const inbox = inboxDir(baseDir, contextKey);
  mkdirSync(inbox, { recursive: true });

  const seen = new Set<string>();
  let stopped = false;

  const scan = () => {
    if (stopped) return;
    try {
      const files = readdirSync(inbox).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp")).sort();
      for (const file of files) {
        if (seen.has(file)) continue;
        const seq = file.replace(/\.json$/, "");
        // Atomic claim: rename to .processing before reading to prevent redelivery on restart
        const srcPath = join(inbox, file);
        const claimPath = join(inbox, `${seq}.processing`);
        try {
          renameSync(srcPath, claimPath);
        } catch {
          continue; // Another process claimed it
        }
        seen.add(file);
        const msg = readSteerMessage(claimPath);
        // Remove claimed file after read
        try { unlinkSync(claimPath); } catch { /* best-effort */ }
        if (msg) {
          onMessage(seq, msg);
        }
      }
    } catch { /* best-effort */ }
  };

  // Initial scan for any pre-existing messages
  scan();

  // fs.watch for real-time detection
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(inbox, () => {
      if (!stopped) scan();
    });
  } catch {
    log.debug("fs.watch failed, relying on polling only");
  }

  // Polling fallback (200ms)
  const pollTimer = setInterval(scan, 200);

  return {
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      watcher?.close();
    },
  };
}

