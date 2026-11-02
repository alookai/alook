import { webTestConfig } from "./vitest.shared"

export default webTestConfig({
  test: {
    name: "web-contracts",
    include: ["src/test/architecture/**/*.test.ts", "src/**/*.architecture.test.ts"],
  },
})
