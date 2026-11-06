import { test, expect } from "@playwright/test"
import { buildSync } from "esbuild"
import { resolve } from "node:path"
import { tid } from "../../lib/community/testids"

const webRoot = resolve(__dirname, "../../..")
const fixture = buildSync({
  stdin: {
    contents: `
      import React, { Profiler } from "react";
      import { createRoot } from "react-dom/client";
      import { ConversationFooterShell } from ${JSON.stringify(resolve(webRoot, "src/components/community/messages/conversation-footer-shell.tsx"))};
      import { tid } from ${JSON.stringify(resolve(webRoot, "src/lib/community/testids.ts"))};
      window.__TAURI__ = {};
      window.keyboardFixture = { calls: 0, commits: 0, hold: false };
      const query = () => {
        window.keyboardFixture.calls++;
        if (window.keyboardFixture.hold) return new Promise(() => {});
        return Promise.resolve({ bottomInset: 244, viewportWidth: 867 });
      };
      if (window.nativeKeyboardPlatform === "android") window.AlookNative = { getKeyboardSnapshot() { window.keyboardFixture.calls++; return JSON.stringify({ bottomInset: 244, viewportWidth: 867 }); } };
      else window.webkit = { messageHandlers: { alookKeyboard: { postMessage: query } } };
      createRoot(document.getElementById("root")).render(
        <Profiler id="keyboard" onRender={() => window.keyboardFixture.commits++}>
          <div style={{ height: "calc(100vh - var(--app-safe-area-bottom))", display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0 }}>Messages</div>
            <ConversationFooterShell {...{ "data-testid": tid.channelComposerShell }} style={{ height: 52, flexShrink: 0, position: "relative" }}>
              <input aria-label="Retained draft" defaultValue="QA295 fold keep" />
            </ConversationFooterShell>
          </div>
        </Profiler>
      );
    `,
    loader: "tsx",
    resolveDir: webRoot,
    sourcefile: "native-keyboard-component-fixture.tsx",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  tsconfig: resolve(webRoot, "tsconfig.json"),
  alias: { "@alook/shared": resolve(webRoot, "../shared/src/mode.ts") },
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
    "process.env": JSON.stringify({ NODE_ENV: "development" }),
  },
}).outputFiles[0].text

for (const platform of ["ios", "android"] as const) test(`${platform} keyboard margin combines static safe bottom once across viewport changes without a React commit`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 382, height: 639 })
  await page.setContent(`<style>
    :root { --app-safe-area-bottom: 34px }
    body { margin: 0 }
    [data-slot="community-composer-accessory-slot"] { position: absolute }
    [data-slot="community-selection-footer-slot"] { display: none }
  </style><div id="root"></div>`)
  await page.evaluate(platform => { (window as unknown as { nativeKeyboardPlatform: string }).nativeKeyboardPlatform = platform }, platform)
  await page.addScriptTag({ content: fixture })
  const footer = page.getByTestId(tid.channelComposerShell)
  await expect.poll(() => footer.evaluate(node => Number.parseFloat(getComputedStyle(node).marginBottom)))
    .toBeCloseTo(244 * 382 / 867 - 34, 1)
  const before = await page.evaluate(() => {
    const fixture = (window as unknown as { keyboardFixture: { calls: number; commits: number; hold: boolean } }).keyboardFixture
    fixture.hold = true
    return { calls: fixture.calls, commits: fixture.commits }
  })
  await page.setViewportSize({ width: 867, height: 639 })
  const after = await footer.evaluate(node => {
    const fixture = (window as unknown as { keyboardFixture: { calls: number; commits: number } }).keyboardFixture
    return { width: innerWidth, margin: Number.parseFloat(getComputedStyle(node).marginBottom),
      bottom: node.getBoundingClientRect().bottom, calls: fixture.calls, commits: fixture.commits }
  })
  await testInfo.attach("viewport-projection", { body: JSON.stringify({ before, after }), contentType: "application/json" })
  expect(after.width).toBe(867)
  expect(after.margin).toBeCloseTo(210, 1)
  expect(after.bottom).toBeCloseTo(395, 1)
  expect(after.commits).toBe(before.commits)
  for (const staticBottom of [0, 34, 300]) {
    await page.evaluate(value => document.documentElement.style.setProperty("--app-safe-area-bottom", `${value}px`), staticBottom)
    expect(await footer.evaluate(node => Number.parseFloat(getComputedStyle(node).marginBottom)))
      .toBeCloseTo(Math.max(0, 244 - staticBottom), 1)
    expect(await footer.evaluate(node => node.getBoundingClientRect().bottom))
      .toBeCloseTo(639 - Math.max(244, staticBottom), 1)
  }
  await page.evaluate(() => document.documentElement.style.setProperty("--app-safe-area-bottom", "34px"))
  await expect(page.getByRole("textbox", { name: "Retained draft" })).toHaveValue("QA295 fold keep")
  await page.setViewportSize({ width: 382, height: 639 })
  expect(await footer.evaluate(node => Number.parseFloat(getComputedStyle(node).marginBottom)))
    .toBeCloseTo(244 * 382 / 867 - 34, 1)
})
