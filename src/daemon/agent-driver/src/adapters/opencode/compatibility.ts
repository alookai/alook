export interface OpenCodeCompatibility {
  readonly major: 1 | 2;
  readonly modelArgs: readonly string[];
  readonly serviceArgs: readonly string[];
  readonly sessionListArgs: (maxCount: number) => readonly string[];
}

export const OPEN_CODE_V1: OpenCodeCompatibility = {
  major: 1,
  modelArgs: ["models", "--pure"],
  serviceArgs: ["serve", "--pure"],
  sessionListArgs: (maxCount) => ["session", "list", "--format", "json", "--max-count", String(maxCount), "--pure"],
};

const OPEN_CODE_V2: OpenCodeCompatibility = {
  major: 2,
  modelArgs: ["models", "--standalone"],
  serviceArgs: ["serve"],
  sessionListArgs: (maxCount) => ["api", "--standalone", "GET", `/api/session?parentID=null&order=desc&limit=${maxCount}`],
};

export function resolveOpenCodeCompatibility(version: string | undefined): OpenCodeCompatibility {
  const match = version?.trim().match(/^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/i);
  if (match?.[1] === "1") return OPEN_CODE_V1;
  if (match?.[1] === "2") return OPEN_CODE_V2;
  throw new Error("Installed OpenCode CLI version is unrecognized or has an unsupported major version");
}
