import { webTestConfig } from "./vitest.shared"

export default webTestConfig({
  test: {
    name: "web-node",
    server: { deps: { inline: ["better-auth"] } },
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.dom.test.{ts,tsx}", "src/test/e2e/**", "src/test/e2e-ui/**", "src/test/architecture/**", "src/**/*.architecture.test.ts", "src/test/e2e-*.test.ts"],
  },
})
