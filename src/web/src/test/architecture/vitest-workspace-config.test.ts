import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../vitest.workspace.config";

describe("Web Vitest workspace contract", () => {
  it("runs both node and workerd projects for the app and auth Worker", () => {
    expect(workspaceConfig).toMatchObject({
      test: {
        projects: [
          "./vitest.config.ts",
          "./vitest.runtime.config.mts",
          "./auth/vitest.config.ts",
          "./auth/vitest.runtime.config.mts",
        ],
      },
    });
  });
});
