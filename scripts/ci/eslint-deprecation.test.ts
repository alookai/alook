import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"
import { verifyDeprecatedReferences } from "./eslint-deprecation-fixture.mjs"

const packages = [
  {
    name: "Web main, Blog, Auth and JavaScript scripts",
    path: "../../src/web/",
    existing: [
      "src/components/community/messages/composer-accessory-rail.dom.test.tsx",
      "src/lib/authenticated-context-menu-policy.ts",
    ],
    locations: [
      { directory: "src", extension: ".test.ts" },
      { directory: "src", extension: ".test.tsx" },
      { directory: "src/app/.well-known", extension: ".test.ts" },
      { directory: "blog/src", extension: ".test.ts" },
      { directory: "auth", extension: ".test.ts" },
      { directory: "scripts", extension: ".mjs" },
    ],
  },
  {
    name: "App source and tests",
    path: "../../src/app/",
    locations: [{ directory: "src", extension: ".test.ts" }],
  },
  {
    name: "Daemon source tests, config and JavaScript tooling",
    path: "../../src/daemon/",
    locations: [
      { directory: "src", extension: ".test.ts" },
      { directory: ".", extension: ".config.ts" },
      { directory: "scripts", extension: ".mjs" },
    ],
  },
  {
    name: "independent agent-driver tests and JavaScript tooling",
    path: "../../src/daemon/agent-driver/",
    locations: [
      { directory: "src", extension: ".test.ts" },
      { directory: "scripts", extension: ".mjs" },
    ],
  },
]

describe("deprecated API lint errors", () => {
  for (const scope of packages) {
    it(`rejects deprecated local and dependency APIs and accepts replacements in ${scope.name}`, () => {
      verifyDeprecatedReferences(fileURLToPath(new URL(scope.path, import.meta.url)), scope.locations, "existing" in scope ? scope.existing : [])
    }, 180_000)
  }
})
