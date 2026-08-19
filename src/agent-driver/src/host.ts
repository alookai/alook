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

export type AgentDriverArtifact =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly content: string;
      readonly target?: never;
    }
  | {
      readonly path: string;
      readonly kind: "symlink";
      readonly target: string;
      readonly content?: never;
    };

export interface AgentDriverResolvedCommand {
  readonly command: string;
  readonly shell: boolean;
}

/**
 * Optional, runtime-neutral OS effects that built-in drivers may request.
 * Backend-specific command names, fallback candidates, artifacts, and module
 * semantics stay in the driver; a host implementation only executes these
 * generic requests and never branches on a runtime id.
 */
export interface AgentDriverSystemEffects {
  resolveCommand(command: string, fallbackPaths?: readonly string[]): Promise<AgentDriverResolvedCommand | null>;
  resolveModule(specifier: string, commandHint?: string): Promise<unknown>;
  writeArtifacts(workingDirectory: string, artifacts: readonly AgentDriverArtifact[]): Promise<void>;
}

export interface AgentDriverHost<TEffects extends object = Record<string, never>> {
  readonly clock: AgentDriverClock;
  readonly logger: AgentDriverLogger;
  readonly effects: TEffects;
}
