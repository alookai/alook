export type AlookMode = "production" | "dev" | "app";

export interface ModeSignals {
  serverUrl?: string;
  cmdPrefix?: string;
  nodeEnv?: string;
  hostname?: string;
}

export function resolveMode(signals: ModeSignals): AlookMode {
  if (signals.nodeEnv === "development" && !signals.cmdPrefix) return "dev";
  if (signals.serverUrl && !signals.cmdPrefix) return "dev";
  if (signals.cmdPrefix) return "app";
  if (signals.hostname && ["localhost", "127.0.0.1"].includes(signals.hostname))
    return "app";
  return "production";
}

export function cliCommand(mode: AlookMode): string {
  switch (mode) {
    case "dev":
      return "pnpm dev:cli";
    case "app":
      return "npx @alook/app cli";
    case "production":
      return "npx @alook/cli";
  }
}

export function daemonCommand(mode: AlookMode): string {
  const base = `${cliCommand(mode)} daemon start`;
  return mode === "dev" ? `${base} --foreground` : base;
}
