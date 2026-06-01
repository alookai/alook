import { resolveMode, cliCommand, getBaseUrl } from "@alook/shared";

export function getServerUrl(): string {
  return getBaseUrl({ serverUrl: process.env.ALOOK_SERVER_URL });
}

export function isDev(): boolean {
  return resolveMode({
    serverUrl: process.env.ALOOK_SERVER_URL,
    cmdPrefix: process.env.ALOOK_CMD_PREFIX,
  }) === "dev";
}

export function cmdPrefix(): string {
  return process.env.ALOOK_CMD_PREFIX || cliCommand(resolveMode({
    serverUrl: process.env.ALOOK_SERVER_URL,
    cmdPrefix: process.env.ALOOK_CMD_PREFIX,
  }));
}
