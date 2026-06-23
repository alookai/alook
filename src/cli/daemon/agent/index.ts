import type {
  ExecOptions,
  AgentMessage,
  AgentResult,
  ParsedEvent,
  StdinMode,
  RuntimeSessionDescriptor,
  DriverLifecycle,
  BusyDeliveryMode,
  EncodeOpts,
} from "../types.js";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { OpenCodeBackend } from "./opencode.js";
import { execSync } from "child_process";

export interface AgentSession {
  pid: number | undefined;
  messages: AsyncIterable<AgentMessage>;
  parsedEvents?: AsyncIterable<ParsedEvent>;
  sessionId: Promise<string>;
  result: Promise<AgentResult>;
  send?(text: string, mode: StdinMode): { ok: boolean; reason?: string };
  closeStdin?(): void;
  descriptor?: RuntimeSessionDescriptor;
}

export interface AgentBackend {
  name: string;
  execute(prompt: string, options: ExecOptions): AgentSession;
  lifecycle?: DriverLifecycle;
  busyDeliveryMode?: BusyDeliveryMode;
  supportsStdinNotification?: boolean;
  parseLine?(line: string): ParsedEvent[];
  encodeStdinMessage?(text: string, mode: StdinMode, opts?: EncodeOpts): string | null;
}

export function descriptorFromDriver(backend: AgentBackend): RuntimeSessionDescriptor {
  return {
    lifecycle: backend.lifecycle ?? { kind: "per_turn" },
    busyDeliveryMode: backend.busyDeliveryMode ?? "none",
    supportsStdinNotification: backend.supportsStdinNotification ?? false,
  };
}

export function createBackend(
  provider: string,
  cliPath: string,
): AgentBackend {
  switch (provider) {
    case "claude":
      return new ClaudeBackend(cliPath);
    case "codex":
      return new CodexBackend(cliPath);
    case "opencode":
      return new OpenCodeBackend(cliPath);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export async function detectVersion(cliPath: string): Promise<string> {
  try {
    return execSync(`${cliPath} --version`, { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}
