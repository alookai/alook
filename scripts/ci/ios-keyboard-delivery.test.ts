import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const runtime = readFileSync(resolve(import.meta.dirname, "../../src/desktop/src-tauri/gen/apple/Sources/alook-desktop/main.mm"), "utf8")

it.runIf(process.platform === "darwin")("bounds live iOS keyboard delivery and flushes the latest state after stalls and errors", () => {
  const publisher = runtime.match(/@interface AlookKeyboardSnapshotPublisher[\s\S]*?@implementation AlookKeyboardSnapshotPublisher[\s\S]*?@end/)?.[0] ?? ""
  const publish = runtime.match(/static void alookPublishKeyboardSnapshots\([\s\S]*?\n\}/)?.[0]
  expect(publish).toBeDefined()
  const directory = mkdtempSync(resolve(tmpdir(), "alook-keyboard-delivery-"))
  try {
    const source = resolve(directory, "delivery.mm")
    const binary = resolve(directory, "delivery")
    writeFileSync(source, `
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <cassert>
#include <cstdio>
static const void *kAlookPublishedKeyboardSnapshotKey = &kAlookPublishedKeyboardSnapshotKey;
@interface UIView : NSObject
@property (nonatomic, strong) NSArray *subviews;
@end
@implementation UIView
@end
@interface UIViewController : NSObject
@property (nonatomic, strong) UIView *view;
@property (nonatomic) BOOL isViewLoaded;
@property (nonatomic, strong) NSDictionary *snapshot;
@end
@implementation UIViewController
@end
@interface WKWebView : UIView
@property (nonatomic, strong) NSMutableArray<NSString *> *scripts;
@property (nonatomic, strong) NSMutableArray *completions;
- (void)evaluateJavaScript:(NSString *)script completionHandler:(void (^)(id, NSError *))completion;
- (void)complete:(NSError *)error;
- (NSDictionary *)lastPacket;
@end
@implementation WKWebView
- (instancetype)init {
    if ((self = [super init])) { _scripts = [NSMutableArray array]; _completions = [NSMutableArray array]; }
    return self;
}
- (void)evaluateJavaScript:(NSString *)script completionHandler:(void (^)(id, NSError *))completion {
    [self.scripts addObject:script];
    if (completion) [self.completions addObject:[completion copy]];
}
- (void)complete:(NSError *)error {
    assert(self.completions.count == 1);
    void (^completion)(id, NSError *) = self.completions.firstObject;
    [self.completions removeObjectAtIndex:0];
    completion(nil, error);
}
- (NSDictionary *)lastPacket {
    NSString *script = self.scripts.lastObject;
    NSUInteger start = [script rangeOfString:@"{detail:"].location + 8;
    NSString *json = [script substringWithRange:NSMakeRange(start, script.length - start - 3)];
    return [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}
@end
static BOOL alookIsTauriRootController(UIViewController *controller) { return controller != nil; }
static NSDictionary *alookMeasureKeyboardSnapshot(UIViewController *controller, WKWebView *webView) { return controller.snapshot; }
${publisher}
${publish}
static void push(UIViewController *controller, double inset, double width, BOOL animating) {
    controller.snapshot = @{ @"bottomInset": @(inset), @"viewportWidth": @(width) };
    alookPublishKeyboardSnapshots(controller, animating);
}
int main() { @autoreleasepool {
    UIViewController *controller = [UIViewController new];
    controller.isViewLoaded = YES;
    controller.view = [UIView new];
    WKWebView *web = [WKWebView new];
    controller.view.subviews = @[web];
    push(controller, 0, 390, YES);
    for (int frame = 1; frame <= 100; frame++) push(controller, frame, 390, YES);
    std::printf("stalled deliveries=%lu\\n", (unsigned long)web.scripts.count);
    std::fflush(stdout);
    assert(web.scripts.count == 1);
    [web complete:nil];
    assert(web.scripts.count == 2 && [web.lastPacket[@"bottomInset"] doubleValue] == 100);
    push(controller, 80, 390, YES);
    push(controller, 20, 844, YES);
    push(controller, 0, 844, NO);
    assert(web.scripts.count == 2);
    [web complete:nil];
    assert(web.scripts.count == 3);
    assert([web.lastPacket[@"bottomInset"] doubleValue] == 0);
    assert([web.lastPacket[@"viewportWidth"] doubleValue] == 844);
    assert(![web.lastPacket[@"isAnimating"] boolValue]);
    [web complete:nil];
    push(controller, 0, 844, NO);
    assert(web.scripts.count == 3 && web.completions.count == 0);
    push(controller, 300, 390, YES);
    push(controller, 0, 844, NO);
    push(controller, 300, 390, YES);
    [web complete:nil];
    assert(web.scripts.count == 4 && web.completions.count == 0);
    push(controller, 300, 390, NO);
    assert(web.scripts.count == 5);
    [web complete:[NSError errorWithDomain:@"test" code:1 userInfo:nil]];
    push(controller, 300, 390, NO);
    assert(web.scripts.count == 6);
    WKWebView *other = [WKWebView new];
    controller.view.subviews = @[web, other];
    push(controller, 150, 390, YES);
    assert(web.scripts.count == 6 && other.scripts.count == 1);
    [other complete:nil];
    [web complete:nil];
    assert(web.scripts.count == 7 && [web.lastPacket[@"bottomInset"] doubleValue] == 150);
    [web complete:nil];
    __weak WKWebView *retired;
    @autoreleasepool {
        WKWebView *temporary = [WKWebView new];
        retired = temporary;
        controller.view.subviews = @[temporary];
        push(controller, 200, 390, YES);
        controller.view.subviews = @[];
    }
    assert(retired == nil);
    std::puts("PASS bounded delivery, latest tuple, reversal, final state, retry after error, isolation and lifetime");
} }
`)
    execFileSync("xcrun", ["--sdk", "macosx", "clang++", "-fobjc-arc", "-std=c++17",
      "-framework", "Foundation", source, "-o", binary], { timeout: 30_000, stdio: "pipe" })
    expect(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }))
      .toContain("PASS bounded delivery, latest tuple, reversal, final state, retry after error, isolation and lifetime")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)
