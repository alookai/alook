import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export class JsonlLocalAgentStore {
  constructor(path) { this.path = path; }
}

export class Cursor {
  static models = { list: async () => [{ id: "fixture-model", displayName: "Fixture model" }] };
}

export class Agent {
  static async create(options) { return this.open("fixture-agent", options, false); }
  static async resume(id, options) { return this.open(id, options, true); }
  static async open(id, options, resume) {
    const cwd = options.local.cwd;
    const history = join(cwd, "fixture-history");
    if (resume && (!existsSync(history) || readFileSync(history, "utf8") !== id)) {
      const error = new Error("Missing");
      error.name = "AgentNotFoundError";
      throw error;
    }
    writeFileSync(history, id);
    appendFileSync(join(cwd, "opens"), `${JSON.stringify({ pid: process.pid, resume, id })}\n`);
    return {
      agentId: id,
      model: { id: "fixture-model" },
      close() {},
      async send(text, { onDelta }) {
        appendFileSync(join(cwd, "inputs"), `${text}\n`);
        let finish;
        let timer;
        const result = new Promise((resolve) => { finish = resolve; });
        const settle = (status) => { clearInterval(timer); finish({ status, result: "done" }); };
        if (text === "spawn") {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
          child.unref();
          writeFileSync(join(cwd, "child-pid"), String(child.pid));
        }
        onDelta({ update: { type: "text-delta", text: "€€😀" } });
        timer = setInterval(() => { if (existsSync(join(cwd, "release"))) settle("finished"); }, 10);
        return {
          id: `run-${text}`,
          wait: () => result,
          cancel: async () => settle("cancelled"),
          steer: async (message) => {
            appendFileSync(join(cwd, "steers"), `${message}\n`);
            if (message === "refuse") return "revert_to_followup";
            if (message === "unknown") throw new Error("unknown delivery");
            return "complete_delivered";
          },
        };
      },
    };
  }
}
