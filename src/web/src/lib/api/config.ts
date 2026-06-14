import { apiFetch } from "./client";

export const fetchModelOptions = () =>
  apiFetch<Record<string, string[]>>("/api/config/model-options");

export const getMinCliVersion = () =>
  apiFetch<{ min_cli_version: string | null }>("/api/config/min-version");

export const fetchLatestCliVersion = () =>
  apiFetch<{ version: string; package: string }>("/api/cli/latest-version");
