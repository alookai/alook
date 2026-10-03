import { apiFetch, type ApiRequestOptions } from "./client";

export const fetchModelOptions = (options?: RequestInit) =>
  apiFetch<Record<string, string[]>>("/api/config/model-options", options);

export const getMinCliVersion = (options?: ApiRequestOptions) =>
  apiFetch<{ min_cli_version: string | null }>("/api/config/min-version", options);

export const fetchLatestCliVersion = (options?: ApiRequestOptions) =>
  apiFetch<{ version: string; package: string }>("/api/cli/latest-version", options);

export const fetchLatestDaemonVersion = (options?: ApiRequestOptions) =>
  apiFetch<{ version: string; package: string }>("/api/daemon/latest-version", options);
