import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const runtime = readFileSync(resolve(root, "src/desktop/src-tauri/gen/apple/Sources/alook-desktop/main.mm"), "utf8")

it.runIf(process.platform === "darwin")("executes the real full frame, published geometry policy and keyboard helpers across system inset shapes", () => {
  const frame = runtime.match(/static CGRect alookNativeContentFrame\([\s\S]*?\n\}/)?.[0]
  const geometry = runtime.match(/static UIEdgeInsets alookGeometryInsets\([\s\S]*?\n\}/)?.[0]
  const keyboard = runtime.match(/static CGFloat alookKeyboardBottomInset\([\s\S]*?\n\}/)?.[0]
  expect(frame).toBeDefined()
  expect(geometry).toBeDefined()
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
${geometry}
${keyboard}
int main() {
  const CGRect host = CGRectMake(0, 0, 1200, 900);
  const CGFloat expectedTop[] = {10, 10, 10, 24, 59, 62};
  unsigned topIndex = 0;
  for (CGFloat top : {0.0, 6.0, 10.0, 24.0, 59.0, 62.0}) {
    const CGFloat policyTop = expectedTop[topIndex++];
    for (CGFloat bottom : {0.0, 20.0, 21.0, 34.0}) {
      UIEdgeInsets original = {top, 12, bottom, 17};
      CGRect app = alookNativeContentFrame(host, original, YES);
      assert(CGRectEqualToRect(app, host));
      assert(app.origin.x == 0 && app.origin.y == 0);
      assert(original.top == top && original.bottom == bottom);
      CGRect other = alookNativeContentFrame(host, original, NO);
      assert(other.origin.y == top && CGRectGetMaxY(other) == 900 - bottom);
      CGRect bounds = CGRectMake(0, 0, app.size.width, app.size.height);
      CGRect safe = CGRectMake(12, top, 1171, 900 - top - bottom);
      UIEdgeInsets published = alookGeometryInsets(bounds, safe);
      assert(published.top == policyTop && published.bottom == 20);
      assert(published.left == 12 && published.right == 17);
      CGRect hiddenGuide = CGRectMake(0, 900 - bottom, 1200, bottom);
      CGRect hiddenInWeb = CGRectOffset(hiddenGuide, -app.origin.x, -app.origin.y);
      assert(alookKeyboardBottomInset(bounds, hiddenInWeb, hiddenGuide, safe) == 0);
      CGRect shownGuide = CGRectMake(0, 600, 1200, 300);
      CGRect shownInWeb = CGRectOffset(shownGuide, -app.origin.x, -app.origin.y);
      CGFloat overlap = alookKeyboardBottomInset(bounds, shownInWeb, shownGuide, safe);
      assert(overlap == 300);
      CGRect outside = CGRectOffset(shownInWeb, 2000, 0);
      assert(alookKeyboardBottomInset(bounds, outside, shownGuide, safe) == 0);
      CGRect covering = CGRectMake(0, -100, bounds.size.width, bounds.size.height + 100);
      assert(alookKeyboardBottomInset(bounds, covering, shownGuide, safe) == bounds.size.height);
    }
  }
  UIEdgeInsets inset = {0, 12, 34, 17};
  CGRect tiny = alookNativeContentFrame(CGRectMake(0, 0, 5, 5), inset, YES);
  assert(CGRectEqualToRect(tiny, CGRectMake(0, 0, 5, 5)));
  CGRect offset = CGRectMake(17, 21, 500, 400);
  assert(CGRectEqualToRect(alookNativeContentFrame(offset, inset, YES), offset));
  UIEdgeInsets offsetPolicy = alookGeometryInsets(offset, CGRectMake(29, 21, 471, 366));
  assert(offsetPolicy.top == 10 && offsetPolicy.bottom == 20);
  assert(offsetPolicy.left == 12 && offsetPolicy.right == 17);
  UIEdgeInsets tinyPolicy = alookGeometryInsets(tiny, CGRectMake(12, 0, 0, 0));
  assert(tinyPolicy.top == 5 && tinyPolicy.bottom == 0);
  assert(tinyPolicy.left == 5 && tinyPolicy.right == 0);
  UIEdgeInsets shortPolicy = alookGeometryInsets(CGRectMake(0, 0, 100, 15), CGRectMake(0, 0, 100, 15));
  assert(shortPolicy.top == 10 && shortPolicy.bottom == 5);
  std::puts("PASS full root bounds, non-root insets, hidden guide, docked overlap and tiny bounds");
}
`)
    execFileSync("xcrun", ["--sdk", "macosx", "clang++", "-fobjc-arc", "-std=c++17",
      "-framework", "Foundation", "-framework", "CoreGraphics", source, "-o", binary],
    { timeout: 30_000, stdio: "pipe" })
    expect(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }))
      .toContain("PASS full root bounds, non-root insets, hidden guide, docked overlap and tiny bounds")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)
