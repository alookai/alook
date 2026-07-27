import { defineConfig, mergeConfig } from "vitest/config"
import { resolve } from "path"
import shared from "../../../vitest.shared"

const dir = resolve(import.meta.dirname)
const root = resolve(dir, "../../../")

// No `@alook/daemon` alias: daemon internals (`WsControlChannel`,
// `startCredentialProxy`/`CredentialBroker`, `createProxyServerApi`) have no
// package-level barrel export for this — test files import them via plain
// relative paths straight into `src/daemon/src/**`, same as the package's own
// unit tests do.
export default mergeConfig(shared, defineConfig({
  resolve: {
    alias: [
      { find: "@alook/test-utils", replacement: resolve(root, "tests/utils/src/index.ts") },
      // Subpaths (`@alook/shared/constants/community`, …) must resolve against
      // the package's `src/` dir, NOT be prefix-rewritten onto `index.ts`
      // (which would yield `index.ts/constants/community` → ENOTDIR). This
      // regex maps `@alook/shared/<sub>` → `src/shared/src/<sub>`; the bare
      // specifier falls through to the exact-match entry below.
      { find: /^@alook\/shared\/(.*)$/, replacement: resolve(root, "src/shared/src") + "/$1" },
      { find: /^@alook\/shared$/, replacement: resolve(root, "src/shared/src/index.ts") },
    ],
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [`${dir}/**/*.test.ts`],
    setupFiles: [`${dir}/setup.ts`],
    fileParallelism: false,
  },
}))
