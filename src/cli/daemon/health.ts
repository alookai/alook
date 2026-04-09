import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";

export function startHealthServer(port: number = 19514): Server {
  const startTime = Date.now();
  const runtimeCount = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: `${uptime}s`,
          runtimes: runtimeCount,
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}

export function createHealthServer(port: number = 19514) {
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
