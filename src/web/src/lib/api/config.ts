import { apiFetch, type ApiRequestOptions } from "./client";

export const fetchLatestDaemonVersion = (options?: ApiRequestOptions) =>
  apiFetch<{ version: string; package: string }>("/api/daemon/latest-version", options);
