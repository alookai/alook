import type { TaskMessage } from "@alook/shared";

const R2_PREFIX = "task-messages/";
const KV_PREFIX = "tm:";
const KV_TTL = 604800; // 7 days

const log = {
  warn(msg: string, ctx: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "warn", service: "task-message-store", msg, ...ctx, ts: new Date().toISOString() }));
  },
};

export class TaskMessageStore {
  constructor(
    private r2: R2Bucket,
    private kv: KVNamespace | null,
  ) {}

  async appendMessages(taskId: string, messages: TaskMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const existing = await this.readAll(taskId);
    const updated = [...existing, ...messages];
    const json = JSON.stringify(updated);

    await this.r2.put(`${R2_PREFIX}${taskId}.json`, json, {
      httpMetadata: { contentType: "application/json" },
    });

    if (this.kv) {
      await this.kv.put(`${KV_PREFIX}${taskId}`, json, { expirationTtl: KV_TTL }).catch((err) => {
        log.warn("KV write failed", { taskId, err });
      });
    }
  }

  async listMessages(
    taskId: string,
    opts?: { since?: number; excludeTypes?: string[] },
  ): Promise<TaskMessage[]> {
    let messages = await this.readAll(taskId);

    if (opts?.since != null) {
      messages = messages.filter((m) => m.seq > opts.since!);
    }
    if (opts?.excludeTypes && opts.excludeTypes.length > 0) {
      const excluded = new Set(opts.excludeTypes);
      messages = messages.filter((m) => !excluded.has(m.type));
    }

    return messages;
  }

  async deleteMessages(taskId: string): Promise<void> {
    await Promise.all([
      this.r2.delete(`${R2_PREFIX}${taskId}.json`),
      this.kv?.delete(`${KV_PREFIX}${taskId}`).catch((err) => {
        log.warn("KV delete failed", { taskId, err });
      }),
    ]);
  }

  private async readAll(taskId: string): Promise<TaskMessage[]> {
    if (this.kv) {
      try {
        const raw = await this.kv.get(`${KV_PREFIX}${taskId}`);
        if (raw) return JSON.parse(raw) as TaskMessage[];
      } catch (err) {
        log.warn("KV read failed, falling back to R2", { taskId, err });
      }
    }

    const obj = await this.r2.get(`${R2_PREFIX}${taskId}.json`);
    if (!obj) return [];

    const text = await obj.text();
    const messages = JSON.parse(text) as TaskMessage[];

    if (this.kv) {
      this.kv.put(`${KV_PREFIX}${taskId}`, text, { expirationTtl: KV_TTL }).catch((err) => {
        log.warn("KV cache-fill failed", { taskId, err });
      });
    }

    return messages;
  }
}
