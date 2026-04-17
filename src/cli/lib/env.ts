export function isDev(): boolean {
  return !!process.env.ALOOK_SERVER_URL;
}

export function cmdPrefix(): string {
  return isDev() ? "pnpm dev:cli" : "npx @alook/cli";
}
