/**
 * `pnpm run mock-server` — the SERVER process (terminal 1).
 *
 * A standalone Alook mock server. It owns ALL server state and the only
 * privileged surfaces; the daemon (separate process) can reach it ONLY over the
 * network, exactly as it would a real server:
 *
 *   - control plane (ws):   server → daemon commands (agent:start/deliver/stop),
 *                           daemon → server reports (ready/session/ack).
 *                           Daemons must connect with `Authorization: Bearer
 *                           <machineKey>` — unauthenticated connections are
 *                           refused (`verifyMachineKey`).
 *   - enroll plane (http):  POST /enroll/agent-credential, Bearer <machineKey> →
 *                           a per-agent runner key. How a daemon turns its machine
 *                           identity into per-agent credentials.
 *   - data plane (http):    POST /api/* — the agent data plane, reached by agents
 *                           THROUGH their credential proxy (which stamps a trusted
 *                           X-Agent-Id). The bridge trusts that header.
 *   - admin plane (http):   POST /admin/* — provisioning, for `test-server` only.
 *                           The daemon process never reaches this (different proc).
 *
 * At startup it enrolls this machine and prints `MACHINE_KEY=sk_machine_…` on its
 * own line so a script (or a human) can hand that key to the daemon. Nothing here
 * is shared in-process with the daemon — the only contract between them is the
 * network surfaces above.
 */
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import { MockServer, WsControlServer } from "../src/server/index";
import { startLocalBridge } from "./localBridge";

const HTTP_PORT = Number(process.env.ALOOK_SERVER_PORT || 4517);
const WS_PORT = Number(process.env.ALOOK_SERVER_WS_PORT || HTTP_PORT + 1);

async function main() {
  const server = new MockServer();

  // Wrap resetRunningAgents to log daemon ready reports
  const originalReset = server.resetRunningAgents.bind(server);
  server.resetRunningAgents = (agentIds: string[]) => {
    console.log(`[mock-server] daemon ready — reported ${agentIds.length} running agent(s)${agentIds.length ? `: ${agentIds.join(", ")}` : ""}`);
    originalReset(agentIds);
  };

  // Enroll THIS machine and surface its key for the daemon (script greps this line).
  const machineKey = server.enrollMachine();

  // Control plane: a ws server, authenticated by machine key. The factory adapts
  // `ws`'s (socket, request) connection event into our (socket, meta) shape,
  // pulling the upgrade request's Authorization header through for verification.
  const wsServer = new WsControlServer({
    server,
    port: WS_PORT,
    verifyMachineKey: (authHeader) => {
      const ok = server.verifyMachineKey(parseBearer(authHeader));
      if (ok) {
        console.log(`[mock-server] daemon connected (machine key verified ✓)`);
      } else {
        console.log(`[mock-server] daemon connection REJECTED (invalid machine key)`);
      }
      return ok;
    },
    onAgentSession: (info) => {
      console.log(`[mock-server] agent session: ${info.agentId} → session=${info.sessionId}`);
    },
    webSocketServerFactory: (port) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `[mock-server] ws port ${port} is in use — another mock-server is likely running.\n` +
              `  Free it (e.g. \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` then kill the PID), ` +
              `or set ALOOK_SERVER_WS_PORT (and ALOOK_SERVER_PORT) to other ports.`,
          );
        } else {
          console.error(`[mock-server] ws server error: ${err.message}`);
        }
        process.exit(1);
      });
      return {
        on: (_event, cb) =>
          wss.on("connection", (socket, req: IncomingMessage) =>
            cb(socket as never, { authHeader: req.headers["authorization"] }),
          ),
        close: (cb) => wss.close(cb),
      };
    },
  });
  wsServer.start();

  // HTTP planes: data (/api), admin (/admin), enroll (/enroll). Same process as
  // the server state — this is the SERVER side; the daemon connects from outside.
  const bridge = await startLocalBridge({ admin: server, api: server, enrollment: server }, HTTP_PORT);

  const wsUrl = `ws://127.0.0.1:${WS_PORT}`;
  // One line per fact; MACHINE_KEY first so `grep '^MACHINE_KEY='` is trivial.
  console.log(`MACHINE_KEY=${machineKey}`);
  console.log(`SERVER_URL=${bridge.url}`);
  console.log(`SERVER_WS_URL=${wsUrl}`);
  console.log(`[mock-server] up — control ws (machineKey-authed) + http (/api /admin /enroll)`);
  console.log(`[mock-server] waiting for a daemon to connect… (Ctrl-C to stop)`);
  console.log(`\n[mock-server] start a daemon in another terminal:\n`);
  console.log(
    `  ALOOK_MACHINE_KEY=${machineKey} ALOOK_SERVER_URL=${bridge.url} ALOOK_SERVER_WS_URL=${wsUrl} pnpm run daemon\n`,
  );

  const shutdown = async () => {
    console.log("\n[mock-server] shutting down…");
    await wsServer.close();
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : undefined;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
