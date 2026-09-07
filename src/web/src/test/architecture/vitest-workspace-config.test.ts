import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../vitest.workspace.config";

describe("Web Vitest workspace contract", () => {
  it("runs node, DOM, and workerd projects without dropping the auth Worker", () => {
    expect(workspaceConfig).toMatchObject({
      test: {
        projects: [
          "./vitest.config.ts",
          "./vitest.dom.config.ts",
          "./vitest.runtime.config.mts",
          "./auth/vitest.config.ts",
          "./auth/vitest.runtime.config.mts",
        ],
      },
    });
  });
});
