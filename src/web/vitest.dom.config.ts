import { webTestConfig } from "./vitest.shared"

export default webTestConfig({
  test: {
    name: "web-dom",
    environment: "jsdom",
    include: ["src/**/*.dom.test.{ts,tsx}", "scripts/**/*.dom.test.{ts,tsx}", "readme-capture/**/*.dom.test.{ts,tsx}", "app-store-capture/**/*.dom.test.{ts,tsx}"],
    exclude: ["src/test/e2e/**", "src/test/e2e-ui/**"],
    setupFiles: ["src/test/react-dom-setup.ts"],
  },
})
