import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const runtime = readFileSync(resolve(root, "src/desktop/src-tauri/gen/apple/Sources/alook-desktop/main.mm"), "utf8")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

it.runIf(process.platform === "darwin")("executes the real native frame and keyboard helpers across system inset shapes", () => {
  const frame = runtime.match(/static CGRect alookNativeContentFrame\([\s\S]*?\n\}/)?.[0]
  const keyboard = runtime.match(/static CGFloat alookKeyboardBottomInset\([\s\S]*?\n\}/)?.[0]
  expect(frame).toBeDefined()
  expect(keyboard).toBeDefined()
  const directory = mkdtempSync(resolve(tmpdir(), "alook-native-insets-"))
  try {
    const source = resolve(directory, "insets.mm")
    const binary = resolve(directory, "insets")
    writeFileSync(source, `
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cassert>
#include <cstdio>
#include <initializer_list>
typedef struct { CGFloat top, left, bottom, right; } UIEdgeInsets;
${frame}
${keyboard}
int main() {
  const CGRect host = CGRectMake(0, 0, 1200, 900);
  for (CGFloat top : {0.0, 6.0, 10.0, 24.0, 59.0, 62.0}) {
    for (CGFloat bottom : {0.0, 20.0, 21.0, 34.0}) {
      UIEdgeInsets original = {top, 12, bottom, 17};
      CGRect app = alookNativeContentFrame(host, original, YES);
      assert(app.origin.x == 12 && app.origin.y == MAX(top, 10.0));
      assert(app.size.width == 1171 && CGRectGetMaxY(app) == 880);
      assert(original.top == top && original.bottom == bottom);
      CGRect other = alookNativeContentFrame(host, original, NO);
      assert(other.origin.y == top && CGRectGetMaxY(other) == 900 - bottom);
      CGRect bounds = CGRectMake(0, 0, app.size.width, app.size.height);
      CGRect safe = CGRectMake(12, top, 1171, 900 - top - bottom);
      CGRect hiddenGuide = CGRectMake(0, 900 - bottom, 1200, bottom);
      CGRect hiddenInWeb = CGRectOffset(hiddenGuide, -app.origin.x, -app.origin.y);
      assert(alookKeyboardBottomInset(bounds, hiddenInWeb, hiddenGuide, safe) == 0);
      CGRect shownGuide = CGRectMake(0, 600, 1200, 300);
      CGRect shownInWeb = CGRectOffset(shownGuide, -app.origin.x, -app.origin.y);
      CGFloat overlap = alookKeyboardBottomInset(bounds, shownInWeb, shownGuide, safe);
      assert(overlap == 280 && overlap + 20 == 300);
      CGRect outside = CGRectOffset(shownInWeb, 2000, 0);
      assert(alookKeyboardBottomInset(bounds, outside, shownGuide, safe) == 0);
      CGRect covering = CGRectMake(0, -100, bounds.size.width, bounds.size.height + 100);
      assert(alookKeyboardBottomInset(bounds, covering, shownGuide, safe) == bounds.size.height);
    }
  }
  UIEdgeInsets inset = {0, 12, 34, 17};
  CGRect tiny = alookNativeContentFrame(CGRectMake(0, 0, 5, 5), inset, YES);
  assert(tiny.size.width == 0 && tiny.size.height == 0);
  std::puts("PASS original insets, trial frame, hidden guide, docked overlap and bounds");
}
`)
    execFileSync("xcrun", ["--sdk", "macosx", "clang++", "-fobjc-arc", "-std=c++17",
      "-framework", "Foundation", "-framework", "CoreGraphics", source, "-o", binary],
    { timeout: 30_000, stdio: "pipe" })
    expect(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }))
      .toContain("PASS original insets, trial frame, hidden guide, docked overlap and bounds")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)

it("executes the actual native safe-area script without copying system values into Web layout", () => {
  const declaration = runtime.match(/static NSString \*const kAlookConsumedSafeAreaScript =\n([\s\S]*?);\n\nstatic CGRect/)?.[1]
  expect(declaration).toBeDefined()
  const script = [...declaration!.matchAll(/@?"((?:\\.|[^"\\])*)"/g)]
    .map(match => JSON.parse(`"${match[1]}"`) as string).join("")
  expect(script).not.toBe("")
  for (const initial of [0, 20, 34]) {
    const values = new Map<string, string>([["color-scheme", "dark"]])
    for (const edge of ["top", "right", "bottom", "left"]) values.set(`--app-safe-area-${edge}`, `${initial}px`)
    const context = { document: { documentElement: { style: { setProperty: (name: string, value: string) => values.set(name, value) } } } }
    runInNewContext(script, context)
    runInNewContext(script, context)
    expect([...values]).toEqual([
      ["color-scheme", "dark"], ["--app-safe-area-top", "0px"], ["--app-safe-area-right", "0px"],
      ["--app-safe-area-bottom", "0px"], ["--app-safe-area-left", "0px"],
    ])
  }
  expect(runtime).toContain("injectionTime:WKUserScriptInjectionTimeAtDocumentStart")
  expect(runtime).toContain("[webView evaluateJavaScript:kAlookConsumedSafeAreaScript completionHandler:nil]")
  const handler = runtime.split("@implementation AlookSafeAreaHandler")[1]?.split("@end")[0] ?? ""
  expect(handler).toContain("@(controller.view.safeAreaInsets.top)")
  expect(handler).not.toContain("MAX(")
  expect(runtime).toContain("kAlookSafeAreaTopKey, @(insets.top)")
})

it("keeps browser env defaults while native UI consumers share the existing app variables", () => {
  const globals = read("src/web/src/app/globals.css")
  for (const edge of ["top", "right", "bottom", "left"]) {
    expect(globals).toContain(`--app-safe-area-${edge}: env(safe-area-inset-${edge}, 0px)`)
  }
  const consumers = [
    "src/web/src/app/(auth)/sign-in/sign-in-client.tsx",
    "src/web/src/components/toaster-provider.tsx",
    "src/web/src/components/ui/toast.tsx",
    "src/web/src/components/community/channels/post-tag-dialog.tsx",
    "src/web/src/components/avatar/bot-avatar-picker-dialog.tsx",
    "src/web/src/components/community/messages/message-reactions.tsx",
    "src/web/src/components/community/messages/image-lightbox.tsx",
  ]
  for (const path of consumers) {
    expect(read(path), path).not.toContain("env(safe-area-inset-")
    expect(read(path), path).toMatch(/(?:var\(|-\()--app-safe-area-/)
  }
  const recovery = read("src/desktop/src-tauri/src/webview_recovery.rs")
  for (const edge of ["top", "right", "bottom", "left"]) {
    expect(recovery).toContain(`var(--app-safe-area-${edge},env(safe-area-inset-${edge}))`)
  }
})
