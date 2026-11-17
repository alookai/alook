import type { AgentModelReport } from "@alook/shared";

export class ModelObservationReporter {
  private readonly pending = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly latest: (agentId: string) => AgentModelReport | undefined,
    private readonly send: (report: AgentModelReport) => void | Promise<void>,
    private readonly onError: () => void,
  ) {}

  schedule(agentId: string): void {
    if (this.stopped) return;
    this.pending.add(agentId);
    this.timer ??= setTimeout(() => this.flush(), 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private flush(): void {
    this.timer = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    for (const agentId of pending) {
      if (this.stopped) return;
      try {
        const report = this.latest(agentId);
        if (report) void Promise.resolve(this.send(report)).catch(this.onError);
      } catch { this.onError(); }
    }
  }
}
