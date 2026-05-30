import { createServer, type IncomingMessage, type ServerResponse } from "http";

const DEFAULT_HEALTH_PORT = Number(process.env.ALOOK_HEALTH_PORT) || 19514;

export function createHealthServer(port: number = DEFAULT_HEALTH_PORT) {
  let runtimeCount = 0;
  const startTime = Date.now();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: `${uptimeSec}s`,
          runtimes: runtimeCount,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, "127.0.0.1");

  return {
    server,
    setRuntimeCount(n: number) {
      runtimeCount = n;
    },
  };
}
