export type AgentDriverLogLevel = "debug" | "info" | "warn" | "error";

export interface AgentDriverLogger {
  write(
    level: AgentDriverLogLevel,
    message: string,
    attributes?: Readonly<Record<string, unknown>>,
  ): void;
}

export interface AgentDriverClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface AgentDriverHost<TEffects extends object = Record<string, never>> {
  readonly clock: AgentDriverClock;
  readonly logger: AgentDriverLogger;
  readonly effects: TEffects;
}
