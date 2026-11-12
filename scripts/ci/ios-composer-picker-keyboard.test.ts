import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { expect, it } from "vitest"

const runtime = readFileSync(resolve(import.meta.dirname,
  "../../src/desktop/src-tauri/gen/apple/Sources/alook-desktop/main.mm"), "utf8")

it.runIf(process.platform === "darwin")("executes the actual iOS picker keyboard bridge across dismissal, stale intent and invalid native ownership", () => {
  const visibility = runtime.match(/static BOOL alookKeyboardGuideVisible\([\s\S]*?\n\}/)?.[0]
  const handler = runtime.match(/static BOOL alookViewContainsFirstResponder\([\s\S]*?@implementation AlookKeyboardHandler[\s\S]*?\n@end/)?.[0]
  expect(visibility).toBeDefined()
  expect(handler).toBeDefined()
  const directory = mkdtempSync(resolve(tmpdir(), "alook-picker-keyboard-"))
  try {
    const source = resolve(directory, "keyboard.mm"), binary = resolve(directory, "keyboard")
    writeFileSync(source, `
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cassert>
#include <cstdio>
typedef NSInteger UISceneActivationState;
const UISceneActivationState UISceneActivationStateForegroundActive = 0;
@interface UIWindowScene : NSObject
@property UISceneActivationState activationState;
@end
@implementation UIWindowScene @end
@interface UILayoutGuide : NSObject
@property CGRect layoutFrame;
@end
@implementation UILayoutGuide @end
@class UIWindow;
@interface UIView : NSObject
@property BOOL isFirstResponder;
@property (strong) NSArray<UIView *> *subviews;
@property (weak) UIView *superview;
@property (strong) UIWindow *window;
@property (strong) UILayoutGuide *keyboardLayoutGuide;
@property (strong) UILayoutGuide *safeAreaLayoutGuide;
@end
@implementation UIView @end
@interface UIWindow : UIView
@property (strong) UIWindowScene *windowScene;
@end
@implementation UIWindow @end
@protocol UIViewControllerTransitionCoordinatorContext
@property (readonly) BOOL isCancelled;
@end
@protocol UIViewControllerTransitionCoordinator
- (BOOL)animateAlongsideTransition:(id)animation completion:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))completion;
@end
@interface UIViewController : NSObject
@property (strong) UIView *view;
@property (strong) UIViewController *presentedViewController;
@property BOOL isBeingDismissed;
@property (strong) id<UIViewControllerTransitionCoordinator> transitionCoordinator;
@end
@implementation UIViewController @end
@interface Transition : NSObject <UIViewControllerTransitionCoordinator, UIViewControllerTransitionCoordinatorContext>
@property BOOL isCancelled;
@property BOOL acceptsCompletion;
@property (copy) void (^completion)(id<UIViewControllerTransitionCoordinatorContext>);
@end
@implementation Transition
- (BOOL)animateAlongsideTransition:(id)animation completion:(void (^)(id<UIViewControllerTransitionCoordinatorContext>))completion {
    if (self.acceptsCompletion) self.completion = completion;
    return self.acceptsCompletion;
}
@end
@protocol WKScriptMessageHandlerWithReply @end
@interface WKWebView : UIView
@property (strong) NSMutableArray<NSString *> *scripts;
- (void)evaluateJavaScript:(NSString *)script completionHandler:(id)completion;
@end
@implementation WKWebView
- (void)evaluateJavaScript:(NSString *)script completionHandler:(id)completion { [self.scripts addObject:script]; }
@end
@interface WKFrameInfo : NSObject
@property BOOL isMainFrame;
@end
@implementation WKFrameInfo @end
@interface WKScriptMessage : NSObject
@property (strong) id body;
@property (strong) WKWebView *webView;
@property (strong) WKFrameInfo *frameInfo;
@end
@implementation WKScriptMessage @end
@interface WKUserContentController : NSObject @end
@implementation WKUserContentController @end
${visibility}
${handler}

int main() { @autoreleasepool {
    UIViewController *root = [UIViewController new]; root.view = [UIView new];
    root.view.keyboardLayoutGuide = [UILayoutGuide new]; root.view.safeAreaLayoutGuide = [UILayoutGuide new];
    root.view.safeAreaLayoutGuide.layoutFrame = CGRectMake(0, 60, 400, 820);
    WKWebView *web = [WKWebView new]; web.superview = root.view; web.scripts = [NSMutableArray new];
    web.window = [UIWindow new]; web.window.windowScene = [UIWindowScene new];
    UIView *content = [UIView new]; content.isFirstResponder = YES; web.subviews = @[content];
    AlookKeyboardHandler *owner = [AlookKeyboardHandler new]; owner.webView = web; owner.viewController = root;
    WKScriptMessage *message = [WKScriptMessage new]; message.webView = web; message.frameInfo = [WKFrameInfo new];
    message.frameInfo.isMainFrame = YES;
    __block id result = nil; __block NSString *error = nil; __block unsigned replies = 0;
    void (^send)(id) = ^(id body) {
        result = nil; error = nil; message.body = body;
        [owner userContentController:nil didReceiveScriptMessage:message replyHandler:^(id value, NSString *failure) {
            result = value; error = failure; replies++;
        }];
    };
    NSString *a = @"11111111-1111-4111-8111-111111111111", *b = @"22222222-2222-4222-8222-222222222222";
    NSDictionary *(^cmd)(NSString *, NSString *) = ^(NSString *verb, NSString *token) { return @{ @"command": verb, @"token": token }; };
    void (^show)(BOOL) = ^(BOOL visible) {
        root.view.keyboardLayoutGuide.layoutFrame = visible ? CGRectMake(0, 600, 400, 300) : CGRectMake(0, 900, 400, 0);
    };
    show(YES); send(@"snapshot"); assert([result[@"resizesViewport"] boolValue] && !error);
    send(cmd(@"capturePicker", @"bad' JS")); assert(error && !result);
    message.frameInfo.isMainFrame = NO; send(cmd(@"capturePicker", a)); assert(error);
    message.frameInfo.isMainFrame = YES;
    WKWebView *other = [WKWebView new]; message.webView = other;
    send(cmd(@"capturePicker", a)); assert(error); message.webView = web;
    show(NO); send(cmd(@"capturePicker", a)); assert(![result[@"captured"] boolValue]);
    show(YES); content.isFirstResponder = NO;
    send(cmd(@"capturePicker", a)); assert(![result[@"captured"] boolValue]); content.isFirstResponder = YES;
    web.window.windowScene.activationState = 1;
    send(cmd(@"capturePicker", a)); assert(![result[@"captured"] boolValue]); web.window.windowScene.activationState = 0;
    UIWindowScene *scene = web.window.windowScene; web.window.windowScene = nil;
    send(cmd(@"capturePicker", a)); assert(![result[@"captured"] boolValue]); web.window.windowScene = scene;

    show(YES); send(cmd(@"capturePicker", a)); assert([result[@"captured"] boolValue]);
    show(NO); send(cmd(@"restorePicker", b)); assert(![result[@"restoring"] boolValue] && web.scripts.count == 0);
    send(cmd(@"restorePicker", a)); assert([result[@"restoring"] boolValue] && web.scripts.count == 1);
    assert([web.scripts.lastObject containsString:a]);
    send(cmd(@"restorePicker", a)); assert(![result[@"restoring"] boolValue] && web.scripts.count == 1);
    show(YES); send(cmd(@"capturePicker", a)); send(cmd(@"restorePicker", a));
    assert(![result[@"restoring"] boolValue] && web.scripts.count == 1);

    UIViewController *picker = [UIViewController new]; Transition *transition = [Transition new]; transition.acceptsCompletion = YES;
    picker.transitionCoordinator = transition; picker.isBeingDismissed = YES; root.presentedViewController = picker;
    show(YES); send(cmd(@"capturePicker", a)); show(NO);
    unsigned before = replies; send(cmd(@"restorePicker", a)); assert(replies == before && web.scripts.count == 1);
    root.presentedViewController = nil; transition.completion(transition);
    assert(replies == before + 1 && [result[@"restoring"] boolValue] && web.scripts.count == 2);

    root.presentedViewController = picker; show(YES); send(cmd(@"capturePicker", a)); show(NO); send(cmd(@"restorePicker", a));
    send(cmd(@"cancelPicker", a)); show(YES); send(cmd(@"capturePicker", b)); show(NO);
    root.presentedViewController = nil; transition.completion(transition); assert(web.scripts.count == 2);
    send(cmd(@"restorePicker", b)); assert([result[@"restoring"] boolValue] && web.scripts.count == 3);

    root.presentedViewController = picker; show(YES); send(cmd(@"capturePicker", a)); show(NO); send(cmd(@"restorePicker", a));
    transition.isCancelled = YES; transition.completion(transition); assert(web.scripts.count == 3); transition.isCancelled = NO;
    root.presentedViewController = nil;
    for (unsigned unavailable = 0; unavailable < 2; unavailable++) {
        show(YES); send(cmd(@"capturePicker", a)); show(NO);
        root.presentedViewController = picker; picker.isBeingDismissed = YES;
        picker.transitionCoordinator = unavailable == 0 ? nil : transition; transition.acceptsCompletion = NO;
        send(cmd(@"restorePicker", a)); assert(![result[@"restoring"] boolValue] && web.scripts.count == 3);
        root.presentedViewController = nil;
    }
    for (unsigned takeover = 0; takeover < 3; takeover++) {
        show(YES); send(cmd(@"capturePicker", a)); show(NO);
        if (takeover == 0) web.window.windowScene.activationState = 1;
        if (takeover == 1) web.superview = nil;
        if (takeover == 2) { root.presentedViewController = picker; picker.isBeingDismissed = NO; }
        send(cmd(@"restorePicker", a)); assert(![result[@"restoring"] boolValue] && web.scripts.count == 3);
        web.window.windowScene.activationState = 0; web.superview = root.view; root.presentedViewController = nil;
    }
    std::puts("PASS actual picker bridge: intent, ownership, dismissal and stale callback isolation");
} }
`)
    execFileSync("xcrun", ["--sdk", "macosx", "clang++", "-fobjc-arc", "-std=c++17",
      "-framework", "Foundation", "-framework", "CoreGraphics", source, "-o", binary], { timeout: 30_000, stdio: "pipe" })
    expect(execFileSync(binary, [], { timeout: 5000, encoding: "utf8" }))
      .toContain("PASS actual picker bridge: intent, ownership, dismissal and stale callback isolation")
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 40_000)
