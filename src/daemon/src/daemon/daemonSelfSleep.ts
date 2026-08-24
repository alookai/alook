export const DAEMON_SELF_SLEEP_TIMEOUT_MS = 15 * 24 * 60 * 60 * 1_000;

export interface DaemonSelfSleepClock {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface DaemonSelfSleepSchedulerOptions {
  onSleep: () => void;
  clock?: DaemonSelfSleepClock;
}

const systemClock: DaemonSelfSleepClock = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

export class DaemonSelfSleepScheduler {
  private readonly clock: DaemonSelfSleepClock;
  private readonly workingAgents = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private started = false;
  private stopped = false;

  constructor(private readonly opts: DaemonSelfSleepSchedulerOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.arm();
  }

  observeMessage(): void {
    if (!this.started || this.stopped) return;
    this.arm();
  }

  observeAgentActivity(agentId: string, working: boolean): void {
    if (this.stopped) return;
    if (working) {
      this.workingAgents.add(agentId);
      if (this.started) this.cancel();
      return;
    }
    if (this.workingAgents.delete(agentId) && this.started && this.workingAgents.size === 0) this.arm();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.workingAgents.clear();
    this.cancel();
  }

  private arm(): void {
    this.cancel();
    if (this.workingAgents.size > 0) return;
    const generation = this.generation;
    this.timer = this.clock.setTimer(() => {
      if (this.stopped || this.generation !== generation || this.workingAgents.size > 0) return;
      this.timer = null;
      this.generation += 1;
      this.opts.onSleep();
    }, DAEMON_SELF_SLEEP_TIMEOUT_MS);
    this.timer.unref?.();
  }

  private cancel(): void {
    this.generation += 1;
    if (!this.timer) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }
}
