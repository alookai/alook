import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyDeprecatedReferences } from "../../../../scripts/ci/eslint-deprecation-fixture.mjs";

test("Logo rejects deprecated local and dependency APIs and accepts replacements", { timeout: 180_000 }, () => {
  verifyDeprecatedReferences(fileURLToPath(new URL("../", import.meta.url)), [
    { directory: "src", extension: ".ts" },
    { directory: "src", extension: ".tsx" },
  ]);
});
