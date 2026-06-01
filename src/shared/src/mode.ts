export type AlookMode = "production" | "dev" | "app";

export interface ModeSignals {
  serverUrl?: string;
  cmdPrefix?: string;
  nodeEnv?: string;
  hostname?: string;
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

export function resolveMode(signals: ModeSignals): AlookMode {
  if (signals.nodeEnv === "development" && !signals.cmdPrefix) return "dev";
  if (signals.serverUrl && !signals.cmdPrefix && signals.nodeEnv !== "production" && isLocalUrl(signals.serverUrl)) return "dev";
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

export interface BaseUrlSignals {
  serverUrl?: string;
  appUrl?: string;
  nodeEnv?: string;
}

const DEFAULT_BASE_URL = "https://alook.ai";
const DEV_BASE_URL = "http://localhost:3000";

export function getBaseUrl(signals: BaseUrlSignals): string {
  if (signals.serverUrl) return signals.serverUrl;
  if (signals.appUrl) return signals.appUrl;
  if (signals.nodeEnv === "development") return DEV_BASE_URL;
  return DEFAULT_BASE_URL;
}
