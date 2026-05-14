export function isDev(): boolean {
  return !!process.env.ALOOK_SERVER_URL && !process.env.ALOOK_CMD_PREFIX;
}

export function cmdPrefix(): string {
  if (process.env.ALOOK_CMD_PREFIX) return process.env.ALOOK_CMD_PREFIX;
  return isDev() ? "pnpm dev:cli" : "npx @alook/cli";
}
