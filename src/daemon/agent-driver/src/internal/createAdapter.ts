import type { BuiltinBackendId } from "../contract.js";
import { ClaudeDriver } from "../adapters/claude/index.js";
import { CodexDriver } from "../adapters/codex/index.js";
import { CursorDriver } from "../adapters/cursor/index.js";
import { OpenCodeDriver } from "../adapters/opencode/index.js";
import { PiDriver } from "../adapters/pi/index.js";
import type { BackendAdapter } from "./adapter.js";

export function createAdapter(backend: BuiltinBackendId): BackendAdapter {
  switch (backend) {
    case "claude": return new ClaudeDriver();
    case "codex": return new CodexDriver();
    case "cursor": return new CursorDriver();
    case "opencode": return new OpenCodeDriver();
    case "pi": return new PiDriver();
  }
}
