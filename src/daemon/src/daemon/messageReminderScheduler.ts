import { localISOString } from "../util/localTime.js";

export interface MessageReminderArmInput {
  agentId: string;
  channel: string;
  sentSeq: number;
  remindAfterMs: number;
}

export type MessageReminderArmResult =
  | { armed: true; dueAt: number }
  | { armed: false; reason: "newer_message_observed" };

interface ReminderRecord extends MessageReminderArmInput {
  sentRef: string;
  startedAt: number;
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface MessageReminderSchedulerOptions {
  deliver(agentId: string, message: { text: string }): unknown;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function reminderKey(agentId: string, channel: string): string {
  return `${agentId}\0${channel}`;
}

function reminderPrompt(channel: string, sentRef: string, startedAt: number): string {
  return `Reminder: At ${localISOString(new Date(startedAt))}, after sending ${sentRef} in ${channel}, you asked to be reminded if no newer message arrived. No newer message has arrived in that conversation.`;
}

/** Daemon-lifetime, in-memory scheduler for opt-in message follow-up reminders. */
export class MessageReminderScheduler {
  private readonly reminders = new Map<string, ReminderRecord>();
  private readonly latestObservedSeq = new Map<string, number>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<MessageReminderSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<MessageReminderSchedulerOptions["clearTimer"]>;

  constructor(private readonly options: MessageReminderSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  arm(input: MessageReminderArmInput): MessageReminderArmResult {
    const key = reminderKey(input.agentId, input.channel);
    const latest = this.latestObservedSeq.get(key);
    if (latest !== undefined && latest > input.sentSeq) {
      return { armed: false, reason: "newer_message_observed" };
    }

    this.clearReminder(key);
    const startedAt = this.now();
    const dueAt = startedAt + input.remindAfterMs;
    const sentRef = `${input.channel}#${input.sentSeq}`;
    const record = {
      ...input,
      sentRef,
      startedAt,
      dueAt,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    record.timer = this.setTimer(() => {
      // Delete first so delivery/re-entrancy can never observe or fire this
      // one-shot record a second time.
      if (this.reminders.get(key) !== record) return;
      this.reminders.delete(key);
      try {
        const delivery = this.options.deliver(input.agentId, {
          text: reminderPrompt(input.channel, sentRef, startedAt),
        });
        // Delivery is best-effort. The manager is currently synchronous, but
        // accepting a Promise-like result here keeps a future async delivery
        // failure from becoming an unhandled rejection that takes down the
        // daemon. A failed reminder remains consumed and is never retried.
        void Promise.resolve(delivery).catch(() => {});
      } catch {
        // A synchronous delivery failure must not escape the timer callback.
      }
    }, input.remindAfterMs);
    record.timer.unref?.();
    this.reminders.set(key, record);
    return { armed: true, dueAt };
  }

  observe(agentId: string, channel: string, latestSeq: number): void {
    const key = reminderKey(agentId, channel);
    const previous = this.latestObservedSeq.get(key);
    if (previous === undefined || latestSeq > previous) {
      this.latestObservedSeq.set(key, latestSeq);
    }
    const reminder = this.reminders.get(key);
    if (reminder && latestSeq > reminder.sentSeq) this.clearReminder(key);
  }

  clearAgent(agentId: string): void {
    const prefix = `${agentId}\0`;
    for (const key of [...this.reminders.keys()]) {
      if (key.startsWith(prefix)) this.clearReminder(key);
    }
    for (const key of [...this.latestObservedSeq.keys()]) {
      if (key.startsWith(prefix)) this.latestObservedSeq.delete(key);
    }
  }

  clearAll(): void {
    for (const key of [...this.reminders.keys()]) this.clearReminder(key);
    this.latestObservedSeq.clear();
  }

  private clearReminder(key: string): void {
    const reminder = this.reminders.get(key);
    if (!reminder) return;
    this.reminders.delete(key);
    this.clearTimer(reminder.timer);
  }
}
