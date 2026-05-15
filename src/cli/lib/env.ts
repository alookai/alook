import { resolveMode, cliCommand } from "@alook/shared";

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
