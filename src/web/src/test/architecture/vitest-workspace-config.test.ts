import { describe, expect, it } from "vitest";
import domConfig from "../../../vitest.dom.config";
import nodeConfig from "../../../vitest.config";
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

  it("keeps Web Node and DOM ownership explicit and disjoint from auth and runtime", () => {
    expect(nodeConfig).toMatchObject({
      test: {
        exclude: expect.arrayContaining(["**/*.dom.test.{ts,tsx}"]),
      },
    });
    expect(domConfig).toMatchObject({
      test: {
        include: [
          "src/**/*.dom.test.{ts,tsx}",
          "blog/**/*.dom.test.{ts,tsx}",
          "scripts/**/*.dom.test.{ts,tsx}",
          "readme-capture/**/*.dom.test.{ts,tsx}",
        ],
      },
    });
  });
});
