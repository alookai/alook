import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

const runtime = readFileSync(resolve(import.meta.dirname,
  "../../src/desktop/src-tauri/gen/apple/Sources/alook-desktop/main.mm"), "utf8")
const start = runtime.indexOf("@interface AlookCommunityRootScrollDelegate")
const end = runtime.indexOf("static void alookInstallCommunityRootScrollLock(", start)
const delegate = runtime.slice(start, end)
const implementation = runtime.slice(start, runtime.indexOf("\n}\n", end) + 3)
const ownerKeys = runtime.match(/^static const void \*kAlookCommunityRoot(?:ScrollDelegateKey|URLObserversKey) = .*;$/gm)?.join("\n")

it("installs the public delegate only on the verified Tauri root and retains its weak forwarding owner", () => {
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const layout = runtime.split("- (void)alook_viewDidLayoutSubviews {")[1]?.split("\n}\n")[0] ?? ""
  expect(layout).toMatch(/WKWebView \*webView = \(WKWebView \*\)subview;\s+if \(isTauriRoot\) \{\s+alookInstallCommunityRootScrollLock\(self.view, webView\);/)
  const install = runtime.slice(end).split("\n}\n")[0]
  expect(install).toContain("webView.superview != host")
  expect(install).toContain("if (observing) return")
  expect(install).toContain("delegate.previousDelegate = webView.scrollView.delegate")
  expect(install).toContain("OBJC_ASSOCIATION_RETAIN_NONATOMIC")
  expect(install).toContain("webView.scrollView.delegate = delegate")
  expect(delegate).toContain("weak) WKWebView *webView")
  expect(delegate).toContain("weak) id<UIScrollViewDelegate> previousDelegate")
})

it.runIf(process.platform === "darwin")("executes the production ObjC delegate against host scroll and WebView doubles", () => {
  const directory = mkdtempSync(join(tmpdir(), "alook-root-scroll-"))
  try {
    const source = join(directory, "delegate.mm")
    const binary = join(directory, "delegate")
    writeFileSync(source, `
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#include <cassert>
#include <cstdio>

@class UIScrollView;
@protocol UIScrollViewDelegate <NSObject>
@optional
- (void)scrollViewDidScroll:(UIScrollView *)scrollView;
- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView;
- (BOOL)scrollViewShouldScrollToTop:(UIScrollView *)scrollView;
@end

@interface UIScrollView : NSObject
@property (nonatomic, weak) id<UIScrollViewDelegate> delegate;
@property (nonatomic) CGPoint contentOffset;
@property (nonatomic) NSUInteger writes;
@property (nonatomic, copy) void (^onScroll)(void);
@end
@implementation UIScrollView
- (void)setContentOffset:(CGPoint)point animated:(BOOL)animated {
    self.contentOffset = point;
    self.writes++;
    if ([self.delegate respondsToSelector:@selector(scrollViewDidScroll:)])
        [self.delegate scrollViewDidScroll:self];
    if (self.onScroll) self.onScroll();
}
@end

@interface UIView : NSObject
@property (nonatomic, weak) UIView *superview;
@end
@implementation UIView
@end

@interface WKWebView : UIView
@property (nonatomic, strong) UIScrollView *scrollView;
@property (nonatomic, copy) NSURL *URL;
@property (nonatomic) NSInteger observers;
@end
@implementation WKWebView
- (void)addObserver:(NSObject *)observer forKeyPath:(NSString *)keyPath
            options:(NSKeyValueObservingOptions)options context:(void *)context {
    [super addObserver:observer forKeyPath:keyPath options:options context:context];
    self.observers++;
}
- (void)removeObserver:(NSObject *)observer forKeyPath:(NSString *)keyPath context:(void *)context {
    [super removeObserver:observer forKeyPath:keyPath context:context];
    self.observers--;
}
@end

${ownerKeys}
${implementation}

@interface RecordingDelegate : NSObject <UIScrollViewDelegate>
@property (nonatomic, strong) NSMutableArray<NSNumber *> *positions;
@property (nonatomic) NSUInteger drags;
@end
@implementation RecordingDelegate
- (instancetype)init {
    self = [super init];
    if (self) self.positions = [NSMutableArray array];
    return self;
}
- (void)scrollViewDidScroll:(UIScrollView *)scrollView {
    [self.positions addObject:@(scrollView.contentOffset.y)];
}
- (void)scrollViewWillBeginDragging:(UIScrollView *)scrollView { self.drags++; }
- (BOOL)scrollViewShouldScrollToTop:(UIScrollView *)scrollView { return NO; }
@end

int main() {
    @autoreleasepool {
        UIView *host = [UIView new];
        WKWebView *webView = [WKWebView new];
        webView.superview = host;
        webView.scrollView = [UIScrollView new];
        UIScrollView *root = webView.scrollView;
        RecordingDelegate *previous = [RecordingDelegate new];
        root.delegate = previous;
        webView.URL = [NSURL URLWithString:@"https://example.test/c"];
        root.contentOffset = CGPointMake(0, 271);
        __block NSUInteger reentry = 0;
        root.onScroll = ^{
            reentry++;
            alookInstallCommunityRootScrollLock(host, webView);
        };
        alookInstallCommunityRootScrollLock(host, webView);
        root.onScroll = nil;
        assert(reentry == 1 && webView.observers == 1);
        AlookCommunityRootScrollDelegate *owner = (AlookCommunityRootScrollDelegate *)root.delegate;
        assert(owner.webView == webView && owner.previousDelegate == previous);
        assert(CGPointEqualToPoint(root.contentOffset, CGPointZero) && root.writes == 1);
        assert([previous.positions isEqualToArray:(@[@0])]);
        alookInstallCommunityRootScrollLock(host, webView);
        assert(root.delegate == owner && webView.observers == 1);

        webView.URL = [NSURL URLWithString:@"https://example.test/sign-in"];
        root.contentOffset = CGPointMake(0, 91);
        root.writes = 0;
        [previous.positions removeAllObjects];
        webView.URL = [NSURL URLWithString:@"https://example.test/c/me"];
        assert(CGPointEqualToPoint(root.contentOffset, CGPointZero) && root.writes == 1);
        assert([previous.positions isEqualToArray:(@[@0])]);

        for (NSString *path in @[@"/c", @"/c/", @"/c/channels/server/channel", @"/c?tab=one"]) {
            webView.URL = [NSURL URLWithString:[@"https://example.test" stringByAppendingString:path]];
            [previous.positions removeAllObjects];
            root.writes = 0;
            [root setContentOffset:CGPointMake(0, 271) animated:NO];
            assert(CGPointEqualToPoint(root.contentOffset, CGPointZero));
            assert(root.writes == 2);
            assert([previous.positions isEqualToArray:(@[@271, @0])]);
            assert(!owner.correcting);
        }

        for (NSString *path in @[@"/", @"/sign-in", @"/c-other", @"/cats", @"/community"]) {
            webView.URL = [NSURL URLWithString:[@"https://example.test" stringByAppendingString:path]];
            root.writes = 0;
            [root setContentOffset:CGPointMake(0, 91) animated:NO];
            assert(root.contentOffset.y == 91 && root.writes == 1);
        }

        webView.URL = [NSURL URLWithString:@"https://example.test/c/me"];
        for (NSNumber *position in @[@271, @164, @(-12)]) {
            root.writes = 0;
            [root setContentOffset:CGPointMake(3, position.doubleValue) animated:NO];
            assert(CGPointEqualToPoint(root.contentOffset, CGPointZero) && root.writes == 2);
        }
        root.writes = 0;
        [root setContentOffset:CGPointZero animated:NO];
        assert(root.writes == 1);

        assert([owner respondsToSelector:@selector(scrollViewWillBeginDragging:)]);
        [(id<UIScrollViewDelegate>)owner scrollViewWillBeginDragging:root];
        assert(previous.drags == 1);
        assert(![(id<UIScrollViewDelegate>)owner scrollViewShouldScrollToTop:root]);
        assert(![owner respondsToSelector:NSSelectorFromString(@"unsupportedCallback")]);

        UIScrollView *inner = [UIScrollView new];
        inner.delegate = owner;
        [inner setContentOffset:CGPointMake(0, 156) animated:NO];
        assert(inner.contentOffset.y == 156 && inner.writes == 1);

        root.delegate = previous;
        alookInstallCommunityRootScrollLock(host, webView);
        assert(root.delegate == previous);
        root.contentOffset = CGPointMake(0, 71);
        root.writes = 0;
        [owner scrollViewDidScroll:root];
        assert(root.contentOffset.y == 71 && root.writes == 0);
        root.delegate = owner;

        owner.correcting = YES;
        [root setContentOffset:CGPointMake(0, 89) animated:NO];
        assert(root.contentOffset.y == 89 && root.writes == 1);
        owner.correcting = NO;

        webView.URL = nil;
        root.writes = 0;
        [root setContentOffset:CGPointMake(0, 81) animated:NO];
        assert(root.contentOffset.y == 81 && root.writes == 1);
        owner.webView = nil;
        webView.URL = [NSURL URLWithString:@"https://example.test/c"];
        root.writes = 0;
        [root setContentOffset:CGPointMake(0, 82) animated:NO];
        assert(root.contentOffset.y == 82 && root.writes == 1);

        owner.webView = webView;
        __weak RecordingDelegate *weakPrevious;
        @autoreleasepool {
            RecordingDelegate *temporaryPrevious = [RecordingDelegate new];
            owner.previousDelegate = temporaryPrevious;
            weakPrevious = temporaryPrevious;
            assert(owner.previousDelegate == temporaryPrevious);
        }
        assert(weakPrevious == nil && owner.previousDelegate == nil);
        owner.previousDelegate = nil;
        [root setContentOffset:CGPointMake(0, 271) animated:NO];
        assert(CGPointEqualToPoint(root.contentOffset, CGPointZero));

        __weak AlookCommunityRootScrollDelegate *weakOwner;
        @autoreleasepool {
            UIView *temporaryHost = [UIView new];
            WKWebView *temporary = [WKWebView new];
            temporary.superview = temporaryHost;
            temporary.scrollView = [UIScrollView new];
            alookInstallCommunityRootScrollLock(temporaryHost, temporary);
            weakOwner = (AlookCommunityRootScrollDelegate *)temporary.scrollView.delegate;
            assert(weakOwner != nil && temporary.scrollView.delegate == weakOwner);
        }
        assert(weakOwner == nil);

        WKWebView *retained = [WKWebView new];
        retained.scrollView = [UIScrollView new];
        @autoreleasepool {
            UIView *temporaryHost = [UIView new];
            retained.superview = temporaryHost;
            alookInstallCommunityRootScrollLock(temporaryHost, retained);
            assert(retained.observers == 1);
        }
        assert(retained.observers == 0 && retained.superview == nil);
        retained.URL = [NSURL URLWithString:@"https://example.test/c"];
        [retained.scrollView setContentOffset:CGPointMake(0, 83) animated:NO];
        assert(retained.scrollView.contentOffset.y == 83);

        WKWebView *replacement = [WKWebView new];
        replacement.scrollView = [UIScrollView new];
        replacement.superview = host;
        webView.superview = nil;
        @autoreleasepool { alookInstallCommunityRootScrollLock(host, replacement); }
        assert(webView.observers == 0 && replacement.observers == 1);
        std::puts("PASS routes, repeated offsets, forwarding, reentrancy, inner scroll and retired ownership");
    }
}
`)
    execFileSync("xcrun", ["--sdk", "macosx", "clang++", "-fobjc-arc", "-std=c++17",
      "-framework", "Foundation", "-framework", "CoreGraphics", source, "-o", binary],
    { timeout: 30_000, stdio: "pipe" })
    const output = execFileSync(binary, [], { timeout: 5000, encoding: "utf8" })
    expect(output).toContain("PASS routes, repeated offsets, forwarding, reentrancy, inner scroll and retired ownership")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)
