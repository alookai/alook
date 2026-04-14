import { log } from "../logger";

export function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  requestId?: string,
  userId?: string
): void {
  if (path === "/health" || path === "/api/health") return;

  const fields: Record<string, unknown> = {};
  if (requestId) fields.requestId = requestId;
  if (userId) fields.userId = userId;

  const reqLog = Object.keys(fields).length > 0 ? log.child(fields) : log;

  const ctx: Record<string, unknown> = {
    method,
    path,
    status,
    duration: `${durationMs}ms`,
  };

  if (status >= 500) reqLog.error("http request", ctx);
  else if (status >= 400) reqLog.warn("http request", ctx);
  else reqLog.info("http request", ctx);
}
