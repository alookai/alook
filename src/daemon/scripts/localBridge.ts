/**
 * The mock-server's HTTP face. The `mock-server` process serves this so other
 * processes (the daemon, `test-server`) reach the server ONLY over the network:
 *   - ENROLL route (POST /enroll/agent-credential) → a daemon exchanges its
 *     machine key for a per-agent runner key.
 *   - DATA routes (POST /api/*)   → the agent data plane, reached by agents
 *     THROUGH their credential proxy (which stamps a trusted X-Agent-Id).
 *   - ADMIN routes (POST /admin/*) → server-side provisioning, used only by
 *     `test-server`. The daemon is a separate process and never reaches admin.
 *
 * The daemon connects to the control plane (ws) and these HTTP planes purely by
 * URL — it holds no server reference. That process boundary is what enforces the
 * admin/daemon separation, structurally rather than by discipline.
 */
import * as http from "http";
import type { AdminApi, ServerApi, EnrollmentApi } from "../src/server/contract";

const ADMIN_METHODS = new Set([
  "createUser",
  "createAgent",
  "createServer",
  "addAgentToServer",
  "createChannel",
  "postMessage",
  "readChannel",
]);
const API_METHODS = new Set(["inboxPull", "inboxSnapshot", "ack", "send", "read", "resolve", "listServers", "listChannels"]);

export interface BridgeDeps {
  admin: AdminApi;
  api: ServerApi;
  /** Machine-credential surface (daemon authed by machineKey). Optional. */
  enrollment?: EnrollmentApi;
}

export function startLocalBridge(deps: BridgeDeps, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => void handle(req, res, deps));
  return new Promise((resolve, reject) => {
    // Surface a listen failure (e.g. EADDRINUSE) as a rejection with a hint,
    // instead of an unhandled 'error' that crashes with a raw stack trace.
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`http port ${port} is in use — free it or set ALOOK_SERVER_PORT to another port`));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${p}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: BridgeDeps): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // ENROLLMENT plane: a daemon exchanges its machine key (Bearer) for a
    // per-agent runner key. Authed by the machineKey, NOT admin/agent identity.
    if (req.method === "POST" && url.pathname === "/enroll/agent-credential") {
      if (!deps.enrollment) return send(res, 404, { error: "enrollment not available" });
      const machineKey = parseBearer(req.headers["authorization"]);
      if (!machineKey) return send(res, 401, { error: "missing machine key", code: "missing_machine_key" });
      const body = (await readBody(req)) as { agentId?: string };
      if (!body.agentId) return send(res, 400, { error: "agentId is required" });
      const result = await deps.enrollment.mintAgentCredential({ machineKey, agentId: body.agentId });
      return send(res, 200, result);
    }

    const m = /^\/(admin|api)\/(\w+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) return send(res, 404, { error: "not found" });
    const [, plane, method] = m;
    const target = plane === "admin" ? deps.admin : deps.api;
    const allowed = plane === "admin" ? ADMIN_METHODS : API_METHODS;
    if (!allowed.has(method)) return send(res, 404, { error: `unknown ${plane} method ${method}` });
    const body = (await readBody(req)) as Record<string, unknown>;

    // DATA plane is the untrusted HTTP boundary: the agent's identity is NOT
    // self-asserted. The credential proxy validated the voucher and stamped a
    // trusted `X-Agent-Id` (derived from the voucher, not the wire). We take
    // agentId ONLY from that header and OVERRIDE any body value — header-only,
    // no body fallback — so a forged body agentId can never take effect. A data
    // request without the header is rejected (the proxy must front it).
    let callBody: unknown = body;
    if (plane === "api") {
      const headerAgentId = req.headers["x-agent-id"];
      const agentId = Array.isArray(headerAgentId) ? headerAgentId[0] : headerAgentId;
      if (!agentId) {
        return send(res, 401, {
          error: "missing X-Agent-Id — data-plane requests must come through the credential proxy",
          code: "missing_agent_identity",
        });
      }
      callBody = { ...body, agentId };
    }

    const fn = (target as unknown as Record<string, (a: unknown) => Promise<unknown>>)[method];
    const result = await fn.call(target, callBody);
    send(res, 200, result ?? {});
  } catch (err) {
    send(res, 400, { error: (err as Error).message, code: (err as { code?: string }).code });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseBearer(authHeader: string | string[] | undefined): string | null {
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Minimal client used by test-server / the alook CLI to call the bridge. */
export async function bridgeCall<T>(baseUrl: string, plane: "admin" | "api", method: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/${plane}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `bridge ${plane}/${method} failed`);
  return json;
}
