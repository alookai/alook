import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [pidFile, mode = "graceful", role = "root", rootPidArg] = process.argv.slice(2);
if (!pidFile) throw new Error("missing pid file");

if (role === "root") {
  if (mode === "late-orphan") {
    writeFileSync(pidFile, JSON.stringify({ root: process.pid, descendant: 0 }));
    const trigger = `${pidFile}.spawn`;
    const timer = setInterval(() => {
      if (!existsSync(trigger)) return;
      clearInterval(timer);
      spawn(process.execPath, [fileURLToPath(import.meta.url), pidFile, mode, "bridge", String(process.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    }, 10);
  } else {
    const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), pidFile, mode, "descendant"], {
      stdio: "ignore",
      windowsHide: true,
    });
    writeFileSync(pidFile, JSON.stringify({ root: process.pid, descendant: descendant.pid }));
    if (mode === "orphan") process.exit(0);
    if (mode === "graceful") {
      const stop = () => {
        descendant.kill("SIGTERM");
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    }
  }
}

if (role === "bridge") {
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), pidFile, mode, "descendant"], {
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(pidFile, JSON.stringify({ root: Number(rootPidArg), bridge: process.pid, descendant: descendant.pid }));
  process.exit(0);
}

if (mode === "stubborn" || mode === "late-orphan" || (mode === "orphan" && role === "descendant")) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

setInterval(() => {}, 1_000);
