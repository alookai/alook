import { defineConfig } from "@playwright/test"
import ordinary from "./playwright.config"

process.env.ALOOK_PUBLIC_STATIC_QA = "1"

export default defineConfig({
  ...ordinary,
  testDir: "./src/test/e2e-ui/_qa/public-static",
  testMatch: "**/*.qa.ts",
  maxFailures: 1,
  projects: ordinary.projects!.flatMap(project => [{
    ...project, name: `${project.name}-phase-capability`, grep: /@phase-capability/,
  }, {
    ...project, grepInvert: /@phase-capability/, dependencies: [`${project.name}-phase-capability`],
  }]),
})
