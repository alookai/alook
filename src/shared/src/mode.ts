export type AlookMode = "production" | "dev" | "app" | "desktop" | "mobile";

export interface ModeSignals {
  serverUrl?: string;
  cmdPrefix?: string;
  nodeEnv?: string;
  hostname?: string;
  tauri?: boolean;
  tauriPlatform?: "desktop" | "mobile";
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname);
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const navigator: any;

function hasWindow(): boolean {
  return typeof globalThis !== "undefined" && "window" in globalThis;
}

export function isTauri(): boolean {
  return hasWindow() && typeof window !== "undefined" && "__TAURI__" in window;
}

export function isDesktop(): boolean {
  if (!isTauri()) return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return !/(android|iphone|ipad|ipod)/i.test(ua);
}

export function isMobile(): boolean {
  if (!isTauri()) return false;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /(android|iphone|ipad|ipod)/i.test(ua);
}

export async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("tauriInvoke called outside of Tauri context");
  }
  const tauri = window.__TAURI__ as Record<string, unknown> | undefined;
  if (!tauri) {
    throw new Error("window.__TAURI__ not available");
  }
  const core = tauri.core as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> } | undefined;
  if (!core?.invoke) {
    throw new Error("window.__TAURI__.core.invoke not available");
  }
  return core.invoke(command, args);
}

export function resolveMode(signals: ModeSignals): AlookMode {
  if (signals.tauri || isTauri()) {
    if (signals.tauriPlatform === "mobile" || isMobile()) return "mobile";
    return "desktop";
  }
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
    case "desktop":
    case "mobile":
    case "production":
      return "npx @alook/cli";
  }
}

export function daemonCommand(mode: AlookMode): string {
  const base = `${cliCommand(mode)} daemon start`;
  return mode === "dev" ? `${base} --foreground` : base;
}

export function cliPackageName(mode: AlookMode): string {
  return mode === "app" ? "@alook/app" : "@alook/cli";
}

export function updateCommand(mode: AlookMode): string {
  const pkg = cliPackageName(mode);
  if (mode === "app") {
    return `npx ${pkg} stop && npx ${pkg}@latest update && npx ${pkg} start`;
  }
  return `npx ${pkg}@latest daemon stop && npx ${pkg}@latest daemon start`;
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
