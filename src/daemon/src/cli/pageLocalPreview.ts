import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve } from "node:path";
import WebSocket from "ws";
import { PAGE_COVER_MAX_BYTES, pageCoverContentType } from "@alook/shared";
import { isAllowedPageRelativePath, preparePageDirectory } from "./pageDirectory.js";
import { ensurePageRuntime, runPageLocalCli, type EnsurePageRuntimeOptions } from "./pageRuntime.js";

export interface LocalPagePreviewResult {
  data: Uint8Array;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  type: string;
  width: number;
  height: number;
}

export interface LocalPagePreviewOptions {
  browserPath?: string;
  runtimeOptions?: EnsurePageRuntimeOptions;
  timeoutMs?: number;
  settleMs?: number;
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_SETTLE_MS = 600;

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export function browserCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (platform === "win32") {
    const roots = [env.ProgramW6432, env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[];
    const suffixes = [
      join("Google", "Chrome", "Application", "chrome.exe"),
      join("Microsoft", "Edge", "Application", "msedge.exe"),
      join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      join("Chromium", "Application", "chrome.exe"),
    ];
    return [...new Set(roots.flatMap(root => suffixes.map(suffix => join(root, suffix))))];
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const fromPath = pathDirs.flatMap(dir => names.map(name => join(dir, name)));
  const standard = names.flatMap(name => [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/snap/bin/${name}`]);
  return [...new Set([...fromPath, ...standard])];
}

export function findLocalBrowser(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const configured = env.ALOOK_PAGE_BROWSER_PATH?.trim() || env.OPEN_ARTIFACT_CHROME?.trim();
  if (configured) {
    if (!exists(configured)) {
      throw new Error(`Configured Chrome/Chromium path does not exist: ${configured}`);
    }
    return configured;
  }
  for (const candidate of browserCandidates(platform, env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* fall back to direct kill */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

async function terminateProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveDone) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(hardCap);
      child.off("exit", finish);
      child.off("close", finish);
      resolveDone();
    };
    child.once("exit", finish);
    child.once("close", finish);
    const escalate = setTimeout(() => signalProcessTree(child, "SIGKILL"), 1_000);
    const hardCap = setTimeout(finish, 3_000);
    escalate.unref();
    hardCap.unref();
    signalProcessTree(child, "SIGTERM");
  });
}

async function normalizeCoverBytes(pngBytes: Uint8Array, width: number, height: number): Promise<{ data: Uint8Array; contentType: "image/png" | "image/jpeg" | "image/webp" }> {
  if (pngBytes.byteLength <= PAGE_COVER_MAX_BYTES) {
    const contentType = pageCoverContentType(pngBytes);
    if (!contentType) throw new Error("Captured Page preview is not a valid raster image");
    return { data: pngBytes, contentType };
  }
  const { default: sharp } = await import("sharp");
  for (const attempt of [
    () => sharp(pngBytes).webp({ quality: 86 }).toBuffer(),
    () => sharp(pngBytes).resize(Math.min(width, 960), Math.min(height, 600), { fit: "cover" }).webp({ quality: 76 }).toBuffer(),
  ]) {
    const out = new Uint8Array(await attempt());
    const contentType = pageCoverContentType(out);
    if (contentType && out.byteLength <= PAGE_COVER_MAX_BYTES) return { data: out, contentType };
  }
  throw new Error("Captured Page preview exceeds the 2 MiB cover limit even after compression");
}

function waitForDevToolsPort(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`Timed out waiting for headless browser DevTools: ${stderr.slice(-300)}`))), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      stderr += String(chunk);
      const match = /DevTools listening on ws:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)\//.exec(stderr);
      if (match) done(() => resolvePort(Number(match[1])));
    };
    const onError = (err: Error) => done(() => reject(new Error(`Failed to launch headless browser: ${err.message}`)));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      done(() => reject(new Error(`Headless browser exited early (${code ?? signal}): ${stderr.slice(-300)}`)));
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function resolvePageTargetWsUrl(port: number, deadlineMs: number): Promise<string> {
  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const targets = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch { /* wait for DevTools HTTP endpoint */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Timed out locating headless browser page target");
}

type CdpListener = (method: string, params: Record<string, unknown>) => void;

class CdpSession {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners: CdpListener[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (typeof msg.method === "string") {
        for (const listener of this.listeners) listener(msg.method, msg.params ?? {});
        return;
      }
      if (typeof msg.id !== "number") return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP command failed"));
      else entry.resolve(msg.result);
    });
    ws.on("close", () => {
      for (const entry of this.pending.values()) entry.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static connect(wsUrl: string, timeoutMs: number): Promise<CdpSession> {
    return new Promise((resolveCdp, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("Timed out connecting to browser CDP")); }, timeoutMs);
      ws.once("open", () => { clearTimeout(timer); resolveCdp(new CdpSession(ws)); });
      ws.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  onEvent(listener: CdpListener) {
    this.listeners.push(listener);
  }

  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolveSend, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

export async function startStaticPageServer(absDir: string): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const realRoot = realpathSync(resolve(absDir));
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
        const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        // Enforce the exact same allowed-file boundary as upload packaging:
        // exclude .env, .git, _agent, .DS_Store, node_modules, and hidden machine files.
        if (!isAllowedPageRelativePath(rel) || rel === ".artifact.json") {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        const filePath = resolve(realRoot, rel);
        if (filePath !== realRoot && !filePath.startsWith(`${realRoot}/`) && !filePath.startsWith(`${realRoot}\\`)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        // Reject any symlink segment along the path (matching preparePageDirectory's zero-symlink rule).
        let cursor = realRoot;
        for (const segment of rel.split("/")) {
          cursor = join(cursor, segment);
          const segInfo = await lstat(cursor).catch(() => null);
          if (!segInfo || segInfo.isSymbolicLink()) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
        }
        const info = await lstat(filePath).catch(() => null);
        if (!info || info.isSymbolicLink() || !info.isFile()) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        const realFile = realpathSync(filePath);
        if (!realFile.startsWith(`${realRoot}/`) && !realFile.startsWith(`${realRoot}\\`)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        res.setHeader("content-type", STATIC_MIME[extname(realFile).toLowerCase()] ?? "application/octet-stream");
        res.end(await readFile(realFile));
      } catch {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    })();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

async function captureUrlWithCdp(
  targetUrl: string,
  options: {
    browserPath: string;
    width: number;
    height: number;
    timeoutMs: number;
    settleMs: number;
    readyExpression?: string;
    label?: string;
  },
): Promise<Uint8Array> {
  const { browserPath, width, height, timeoutMs, settleMs, readyExpression, label = "Local page" } = options;
  const userDataDir = await mkdtemp(join(tmpdir(), "alook-page-preview-"));
  let child: ChildProcess | null = null;
  let cdp: CdpSession | null = null;

  try {
    const deadline = Date.now() + timeoutMs;
    child = spawn(browserPath, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--mute-audio",
      ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "about:blank",
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });

    const cdpPort = await waitForDevToolsPort(child, Math.min(10_000, timeoutMs));
    const wsUrl = await resolvePageTargetWsUrl(cdpPort, deadline);
    cdp = await CdpSession.connect(wsUrl, Math.max(2_000, deadline - Date.now()));

    let mainStatus = 0;
    let fatalError: string | null = null;
    cdp.onEvent((method, params) => {
      if (method === "Network.responseReceived" && params.type === "Document") {
        const response = params.response as { status?: number; url?: string } | undefined;
        const status = typeof response?.status === "number" ? response.status : 0;
        if (status > 0) {
          mainStatus = status;
          if (status >= 400) fatalError = `${label} returned HTTP ${status}`;
        }
      }
    });

    await cdp.send("Page.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: targetUrl });

    const expr = readyExpression
      ?? "document.readyState === 'complete' && !!document.body && (document.body.innerText.trim().length > 0 || document.querySelector('img,canvas,svg,video,iframe') !== null)";
    let ready = false;
    while (Date.now() < deadline) {
      if (fatalError) throw new Error(fatalError);
      const evalRes = await cdp.send<{ result?: { value?: boolean } }>("Runtime.evaluate", {
        returnByValue: true,
        expression: expr,
      }, Math.min(3_000, Math.max(500, deadline - Date.now())));
      if (mainStatus >= 200 && mainStatus < 400 && evalRes.result?.value === true) {
        ready = true;
        break;
      }
      await new Promise(done => setTimeout(done, 100));
    }
    if (fatalError) throw new Error(fatalError);
    if (!ready) throw new Error(`Timed out waiting for ${label} to render visible content`);
    await new Promise(done => setTimeout(done, Math.min(settleMs, Math.max(100, deadline - Date.now()))));

    const shot = await cdp.send<{ data?: string }>("Page.captureScreenshot", { format: "png" }, Math.max(3_000, deadline - Date.now()));
    if (!shot.data) throw new Error("Headless browser returned an empty screenshot");
    return new Uint8Array(Buffer.from(shot.data, "base64"));
  } finally {
    cdp?.close();
    await terminateProcessTree(child);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function captureStaticPageDirectory(
  absDir: string,
  browserPath: string,
  width: number,
  height: number,
  timeoutMs: number,
  settleMs: number,
): Promise<Uint8Array> {
  const { server, port } = await startStaticPageServer(absDir);
  try {
    return await captureUrlWithCdp(`http://127.0.0.1:${port}/`, {
      browserPath,
      width,
      height,
      timeoutMs,
      settleMs,
      label: "Local Page index.html",
    });
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function waitForTypeServerReady(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`Timed out starting local Open Artifact server: ${stderr.slice(-300)}`))), timeoutMs);
    const onStdout = (chunk: Buffer | string) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { openArtifact?: string; url?: string };
          const readyUrl = parsed.url;
          if (parsed.openArtifact === "ready" && typeof readyUrl === "string") {
            done(() => resolveUrl(readyUrl));
            return;
          }
        } catch { /* wait for complete JSON line */ }
      }
    };
    const onStderr = (chunk: Buffer | string) => { stderr += String(chunk); };
    const onError = (err: Error) => done(() => reject(err));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      done(() => reject(new Error(`Local Open Artifact server exited early (${code ?? signal}): ${stderr.slice(-300)}`)));
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function captureBuiltinArtifactDirectory(
  absDir: string,
  type: string,
  browserPath: string,
  width: number,
  height: number,
  timeoutMs: number,
  settleMs: number,
  runtimeOptions?: EnsurePageRuntimeOptions,
): Promise<Uint8Array> {
  const runtime = await ensurePageRuntime(runtimeOptions);
  const secret = randomBytes(24).toString("hex");
  const stateHome = await mkdtemp(join(tmpdir(), "alook-oa-serve-"));
  let child: ChildProcess | null = null;

  try {
    child = spawn(process.execPath, [runtime.cliPath, "serve", "--type", type, "--port", "0", "--idle", "1"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        OPEN_ARTIFACT_SECRET: secret,
        OPEN_ARTIFACT_CHROME: browserPath,
        OPEN_ARTIFACT_TYPE_SERVER_HOME: stateHome,
        OPEN_ARTIFACT_PORT: "",
        OPEN_ARTIFACT_DAEMON_URL: "",
        OPEN_ARTIFACT_TYPE_TOKEN: "",
        OPEN_ARTIFACT_TYPE: "",
      },
    });
    const baseUrl = await waitForTypeServerReady(child, Math.min(15_000, timeoutMs));
    const response = await fetch(new URL("/__open-artifact/open", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ root: absDir, type }),
      signal: AbortSignal.timeout(Math.min(15_000, timeoutMs)),
    });
    const body = (await response.json().catch(() => null)) as { page_url?: string; url?: string; error?: string; message?: string } | null;
    const targetUrl = body?.page_url || body?.url;
    if (!response.ok || !targetUrl) {
      throw new Error(body?.message || body?.error || `Local editor open failed (${response.status})`);
    }
    // Load the editor's direct index.html (bypassing the Shell iframe wrapper on docs/slides/design/sheets)
    // so cover thumbnails show the clean artifact content directly and DOM readiness checks inspect the editor itself.
    const editorUrl = new URL("./index.html", targetUrl.endsWith("/") ? targetUrl : `${targetUrl}/`).href;
    const readyExpression = type === "sheets"
      ? "document.readyState === 'complete' && document.querySelector('[role=gridcell]') !== null"
      : type === "motion"
        ? "document.readyState === 'complete' && !!document.body && !document.body.innerText.includes('Loading the animation') && (document.querySelector('canvas,svg,video') !== null || document.body.innerText.trim().length > 0)"
        : "document.readyState === 'complete' && !!document.body && (document.body.innerText.trim().length > 0 || document.querySelector('canvas,svg,img,video,iframe') !== null)";
    return await captureUrlWithCdp(editorUrl, {
      browserPath,
      width,
      height,
      timeoutMs,
      settleMs: Math.max(settleMs, 1_200),
      readyExpression,
      label: `Local ${type} editor`,
    });
  } finally {
    await terminateProcessTree(child);
    await rm(stateHome, { recursive: true, force: true }).catch(() => {});
  }
}

export async function captureLocalPagePreview(
  directory: string,
  options: LocalPagePreviewOptions = {},
): Promise<LocalPagePreviewResult> {
  const prepared = await preparePageDirectory(directory);
  const browserPath = options.browserPath ?? findLocalBrowser();
  if (!browserPath) {
    throw new Error("No local Chrome, Chromium, or Edge browser found to render the Page preview. Install Chrome/Chromium, set ALOOK_PAGE_BROWSER_PATH, or pass --cover <image>.");
  }
  const absDir = realpathSync(resolve(directory));
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;

  const rawPng = prepared.type === "page"
    ? await captureStaticPageDirectory(absDir, browserPath, width, height, timeoutMs, settleMs)
    : await captureBuiltinArtifactDirectory(absDir, prepared.type, browserPath, width, height, timeoutMs, settleMs, options.runtimeOptions);

  const normalized = await normalizeCoverBytes(rawPng, width, height);
  return { ...normalized, type: prepared.type, width, height };
}

export async function serveStaticPagePreviewLoop(directory: string, idleSeconds = 600): Promise<void> {
  const absDir = realpathSync(resolve(directory));
  const { server, port } = await startStaticPageServer(absDir);
  const idleMs = Math.max(5_000, Math.min(3_600_000, Math.round(idleSeconds * 1000)));
  await new Promise<void>((resolveDone) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const shutdown = () => {
      if (timer) clearTimeout(timer);
      server.close(() => resolveDone());
    };
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(shutdown, idleMs);
    };
    server.on("request", resetTimer);
    resetTimer();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.stdout.write(`${JSON.stringify({ alookStaticPreview: "ready", url: `http://127.0.0.1:${port}/`, pid: process.pid })}\n`);
  });
}

export async function openLocalPagePreview(
  directory: string,
  options: { runtimeOptions?: EnsurePageRuntimeOptions; cliEntryPath?: string; idleSeconds?: number; timeoutMs?: number } = {},
): Promise<{ mode: "interactive"; type: string; dir: string; url: string; pid?: number; stopHint: string }> {
  const prepared = await preparePageDirectory(directory);
  const absDir = realpathSync(resolve(directory));
  const timeoutMs = options.timeoutMs ?? 20_000;

  if (prepared.type !== "page") {
    const runtime = await ensurePageRuntime(options.runtimeOptions);
    const result = await runPageLocalCli(runtime, ["open", absDir, "--type", prepared.type, "--json"], { timeoutMs });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Local preview open failed (${result.exitCode})`);
    }
    const line = result.stdout.trim().split(/\r?\n/).reverse().find(l => l.trim().startsWith("{"));
    const parsed = line ? (JSON.parse(line) as { url?: string; page_url?: string }) : null;
    const url = parsed?.url || parsed?.page_url;
    if (!url) throw new Error(`Local preview did not return a URL: ${result.stdout.slice(0, 200)}`);
    return { mode: "interactive", type: prepared.type, dir: absDir, url, stopHint: "alook page local stop" };
  }

  const cliEntry = options.cliEntryPath ?? process.argv[1];
  if (!cliEntry) throw new Error("Unable to locate CLI entry point for static Page preview");
  const idleSeconds = options.idleSeconds ?? 600;
  const child = spawn(process.execPath, [cliEntry, "page", "_serve-static", "--dir", absDir, "--idle", String(idleSeconds)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      done(() => reject(new Error(`Timed out starting local Page preview server: ${stderr.slice(-200)}`)));
    }, Math.min(10_000, timeoutMs));
    const onStdout = (chunk: Buffer | string) => {
      stdout += String(chunk);
      for (const l of stdout.split(/\r?\n/)) {
        if (!l.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(l) as { alookStaticPreview?: string; url?: string };
          if (parsed.alookStaticPreview === "ready" && typeof parsed.url === "string") {
            const readyUrl = parsed.url;
            done(() => resolveUrl(readyUrl));
            return;
          }
        } catch { /* wait for full line */ }
      }
    };
    const onStderr = (chunk: Buffer | string) => { stderr += String(chunk); };
    const onError = (err: Error) => done(() => reject(err));
    const onExit = (code: number | null) => done(() => reject(new Error(`Static Page preview server exited early (${code}): ${stderr.slice(-200)}`)));
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return {
    mode: "interactive",
    type: "page",
    dir: absDir,
    url,
    pid: child.pid,
    stopHint: child.pid ? `kill ${child.pid} (auto-exits after ${idleSeconds}s idle)` : `auto-exits after ${idleSeconds}s idle`,
  };
}

export async function writeLocalPagePreviewFile(
  directory: string,
  outPath: string,
  options: LocalPagePreviewOptions = {},
) {
  const preview = await captureLocalPagePreview(directory, options);
  const resolvedOut = resolve(outPath);
  await writeFile(resolvedOut, preview.data);
  return {
    mode: "screenshot" as const,
    path: resolvedOut,
    type: preview.type,
    contentType: preview.contentType,
    bytes: preview.data.byteLength,
    width: preview.width,
    height: preview.height,
  };
}
