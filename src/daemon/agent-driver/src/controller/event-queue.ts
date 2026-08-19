import type { AgentEventStream } from "../contract.js";

const MAX_BUFFERED_BYTES = 4_194_304 as const;

interface Waiter<Event> {
  resolve(value: IteratorResult<Event>): void;
}

export class BufferedEventQueue<Event> {
  private readonly queued: Array<{ event: Event; bytes: number }> = [];
  private readonly waiters: Waiter<Event>[] = [];
  private bufferedBytes = 0;
  private iteratorCreated = false;
  private consumerClosed = false;
  private overflowed = false;
  private ended = false;

  constructor(
    private readonly onConsumerClosed: () => void,
    private readonly onOverflow: () => void,
  ) {}

  readonly stream: AgentEventStream<Event> = {
    maxBufferedBytes: MAX_BUFFERED_BYTES,
    [Symbol.asyncIterator]: () => this.createIterator(),
  };

  push(event: Event, terminal = false): boolean {
    if (this.ended) return false;
    if (this.overflowed && !terminal) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return true;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (!terminal && this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
      this.overflowed = true;
      this.onOverflow();
      return false;
    }
    this.queued.push({ event, bytes });
    this.bufferedBytes += bytes;
    return true;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  private createIterator(): AsyncIterator<Event> {
    if (this.iteratorCreated) throw new Error("AgentEventStream supports one consumer");
    this.iteratorCreated = true;
    return {
      next: () => {
        const item = this.queued.shift();
        if (item) {
          this.bufferedBytes -= item.bytes;
          return Promise.resolve({ done: false as const, value: item.event });
        }
        if (this.ended) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<Event>>((resolve) => this.waiters.push({ resolve }));
      },
      return: async () => {
        if (!this.consumerClosed) {
          this.consumerClosed = true;
          this.onConsumerClosed();
        }
        return { done: true, value: undefined };
      },
    };
  }
}
