import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureLocalPagePreview, findLocalBrowser, startStaticPageServer } from "./pageLocalPreview";

describe("findLocalBrowser", () => {
  it("honors ALOOK_PAGE_BROWSER_PATH and OPEN_ARTIFACT_CHROME and fails fast if missing", () => {
    expect(findLocalBrowser("linux", { ALOOK_PAGE_BROWSER_PATH: "/custom/chrome" }, p => p === "/custom/chrome")).toBe("/custom/chrome");
    expect(findLocalBrowser("linux", { OPEN_ARTIFACT_CHROME: "/oa/chrome" }, p => p === "/oa/chrome")).toBe("/oa/chrome");
    expect(() => findLocalBrowser("linux", { ALOOK_PAGE_BROWSER_PATH: "/missing/chrome" }, () => false)).toThrow("does not exist");
  });

  it("discovers standard macOS, Linux, and Windows browsers or returns null when absent", () => {
    expect(findLocalBrowser("darwin", {}, p => p.includes("Google Chrome.app"))).toContain("Google Chrome");
    expect(findLocalBrowser("linux", { PATH: "/usr/local/bin" }, p => p === "/usr/local/bin/chromium")).toBe("/usr/local/bin/chromium");
    expect(findLocalBrowser("win32", { PROGRAMFILES: "C:\\Program Files" }, p => p.endsWith("msedge.exe"))).toContain("msedge.exe");
    expect(findLocalBrowser("linux", { PATH: "" }, () => false)).toBeNull();
  });
});

describe("captureLocalPagePreview", () => {
  it("renders a local generic page directory into a valid 16:10 raster cover when a local browser is installed", async () => {
    const browserPath = findLocalBrowser();
    if (!browserPath) return;

    const dir = await mkdtemp(join(tmpdir(), "alook-local-preview-"));
    try {
      await writeFile(join(dir, ".artifact.json"), JSON.stringify({ type: "page", title: "Local Preview Test" }));
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html><body style="margin:0;height:800px;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;font:700 42px sans-serif"><h1>Pre-Upload Local Cover</h1></body></html>',
      );
      const preview = await captureLocalPagePreview(dir, { browserPath, settleMs: 150, timeoutMs: 15_000 });
      expect(preview.type).toBe("page");
      expect(preview.contentType).toBe("image/png");
      expect(preview.width).toBe(1280);
      expect(preview.height).toBe(800);
      expect(preview.data.byteLength).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty generic page directory before launching a browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alook-local-invalid-"));
    try {
      await expect(captureLocalPagePreview(dir, { browserPath: "/missing/chrome" })).rejects.toThrow(".artifact.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces upload archiveKeeps boundary on static preview (blocks .env, .git, node_modules, .artifact.json; allows normal assets)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alook-local-boundary-"));
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, ".artifact.json"), JSON.stringify({ type: "page", title: "Boundary Test" }));
    await writeFile(join(dir, "index.html"), "<h1>OK</h1>");
    await writeFile(join(dir, "assets", "app.js"), "console.log('ok');");
    await writeFile(join(dir, ".env"), "SECRET_MARKER=1");
    await writeFile(join(dir, ".git", "config"), "[core]\n");
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "excluded");

    const { server, port } = await startStaticPageServer(dir);
    try {
      const okHtml = await fetch(`http://127.0.0.1:${port}/`);
      expect(okHtml.status).toBe(200);
      expect(await okHtml.text()).toContain("<h1>OK</h1>");

      const okAsset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
      expect(okAsset.status).toBe(200);
      expect(await okAsset.text()).toContain("console.log('ok')");

      for (const blocked of ["/.env", "/.git/config", "/node_modules/pkg/index.js", "/.artifact.json"]) {
        const res = await fetch(`http://127.0.0.1:${port}${blocked}`);
        expect(res.status, blocked).toBe(404);
      }

      if (process.platform !== "win32") {
        const externalDir = await mkdtemp(join(tmpdir(), "alook-local-canary-"));
        try {
          await writeFile(join(externalDir, "canary.txt"), "CANARY_OUTSIDE_ROOT");
          await symlink(externalDir, join(dir, "linked"));
          const escaped = await fetch(`http://127.0.0.1:${port}/linked/canary.txt`);
          expect(escaped.status).toBe(404);
        } finally {
          await rm(externalDir, { recursive: true, force: true });
        }
      }
    } finally {
      await new Promise<void>(r => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
