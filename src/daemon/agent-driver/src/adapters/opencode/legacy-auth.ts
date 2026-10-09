import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parse(value: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

async function readJson(filename: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  try {
    const file = await open(filename, "r");
    try {
      if ((await file.stat()).size > maxBytes) return undefined;
      return parse(await file.readFile("utf8"));
    } finally { await file.close(); }
  } catch { return undefined; }
}

function xdgRoot(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) ? value : fallback;
}

export async function legacyOpenCodeApiEnvironment(
  environment: Environment,
  model: string | undefined,
): Promise<Record<string, string>> {
  if (!model || model.indexOf("/") < 1) return {};
  if (environment.OPENCODE_MODELS_URL
    && environment.OPENCODE_MODELS_URL !== "https://models.opencode.ai"
    && !environment.OPENCODE_MODELS_PATH) return {};
  const provider = model.slice(0, model.indexOf("/"));
  const home = (process.platform === "win32" ? environment.USERPROFILE : undefined)
    || environment.HOME || homedir();
  const cache = xdgRoot(environment.XDG_CACHE_HOME, path.join(home, ".cache"));
  const catalog = await readJson(
    environment.OPENCODE_MODELS_PATH || path.join(cache, "opencode", "models.json"),
    16 * 1024 * 1024,
  );
  const providerInfo = record(catalog?.[provider]);
  const names = Array.isArray(providerInfo?.env)
    ? providerInfo.env.filter((name): name is string => typeof name === "string")
    : [];
  if (names.some((name) => environment[name] !== undefined)) return {};
  const name = names.find((name) => /^[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN)$/.test(name));
  if (!name) return {};
  const data = xdgRoot(environment.XDG_DATA_HOME, path.join(home, ".local", "share"));
  const auth = (environment.OPENCODE_AUTH_CONTENT ? parse(environment.OPENCODE_AUTH_CONTENT) : undefined)
    ?? await readJson(path.join(data, "opencode", "auth.json"), 1024 * 1024);
  const credential = record(auth?.[provider]);
  return credential?.type === "api" && typeof credential.key === "string" && credential.key.trim()
    ? { [name]: credential.key }
    : {};
}
