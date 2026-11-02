import { webTestConfig } from "./vitest.shared"

export default webTestConfig({
  test: {
    name: "web-tooling",
    include: ["src/test/e2e-*.test.ts", "scripts/**/*.test.ts", "readme-capture/**/*.test.ts", "app-store-capture/**/*.test.ts"],
    exclude: ["**/*.dom.test.{ts,tsx}"],
  },
})
