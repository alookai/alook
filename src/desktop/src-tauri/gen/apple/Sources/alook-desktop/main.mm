#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

static UIColor *alookLightColor(void) {
    return [UIColor colorWithRed:0.980392 green:0.964706 blue:0.933333 alpha:1.0];
}

static UIColor *alookDarkColor(void) {
    return [UIColor colorWithRed:0.0 green:0.0 blue:0.0 alpha:1.0];
}

static const void *kAlookResolvedDarkThemeKey = &kAlookResolvedDarkThemeKey;
static const void *kAlookWebBackgroundKey = &kAlookWebBackgroundKey;
static const void *kAlookWebDarkThemeKey = &kAlookWebDarkThemeKey;
static const void *kAlookThemeHandlerKey = &kAlookThemeHandlerKey;
static const void *kAlookGeometryKey = &kAlookGeometryKey;
static const void *kAlookKeyboardLayoutViewKey = &kAlookKeyboardLayoutViewKey;
static const void *kAlookCommunityRootScrollDelegateKey = &kAlookCommunityRootScrollDelegateKey;
static const void *kAlookCommunityRootURLObserversKey = &kAlookCommunityRootURLObserversKey;
static const void *kAlookPublishedKeyboardSnapshotKey = &kAlookPublishedKeyboardSnapshotKey;
static const void *kAlookStartupOverlayKey = &kAlookStartupOverlayKey;
static const void *kAlookStartupCompletedKey = &kAlookStartupCompletedKey;
static const NSInteger kAlookStartupLogoTag = 8738;
static const NSInteger kAlookStartupErrorTag = 8739;
static UIView *gAlookStartupOverlay = nil;
static BOOL gAlookStartupCompleted = NO;
static BOOL gAlookStartupFailed = NO;

static BOOL alookIsTauriRootController(UIViewController *viewController);

static CGRect alookNativeContentFrame(CGRect bounds, UIEdgeInsets systemInsets, BOOL isTauriRoot) {
    if (isTauriRoot) return bounds;
    return CGRectMake(systemInsets.left, systemInsets.top,
        bounds.size.width - systemInsets.left - systemInsets.right,
        bounds.size.height - systemInsets.top - systemInsets.bottom);
}

static UIEdgeInsets alookGeometryInsets(CGRect bounds, CGRect safe) {
    UIEdgeInsets insets;
    insets.left = MIN(bounds.size.width, MAX(0, CGRectGetMinX(safe) - CGRectGetMinX(bounds)));
    insets.right = MIN(bounds.size.width - insets.left, MAX(0, CGRectGetMaxX(bounds) - CGRectGetMaxX(safe)));
    insets.top = MIN(bounds.size.height, MAX(10.0, CGRectGetMinY(safe) - CGRectGetMinY(bounds)));
    insets.bottom = MIN(bounds.size.height - insets.top, 20.0);
    return insets;
}

static NSDictionary *alookMeasureGeometry(UIViewController *controller, WKWebView *webView) {
    if (!alookIsTauriRootController(controller) || webView.superview != controller.view ||
        webView.window == nil || CGRectIsEmpty(webView.bounds)) return nil;
    CGRect bounds = webView.bounds;
    CGRect safe = [webView convertRect:controller.view.safeAreaLayoutGuide.layoutFrame fromView:controller.view];
    UIEdgeInsets insets = alookGeometryInsets(bounds, safe);
    return @{ @"top": @(insets.top), @"right": @(insets.right), @"bottom": @(insets.bottom), @"left": @(insets.left),
              @"viewportWidth": @(bounds.size.width), @"viewportHeight": @(bounds.size.height), @"caption": @NO };
}

static CGFloat alookKeyboardBottomInset(CGRect bounds, CGRect keyboardFrame,
                                      CGRect keyboardGuideFrame, CGRect safeAreaFrame) {
    if (CGRectGetMinY(keyboardGuideFrame) >= CGRectGetMaxY(safeAreaFrame)) return 0;
    return CGRectIntersectsRect(bounds, keyboardFrame)
        ? MIN(bounds.size.height, MAX(0, CGRectGetMaxY(bounds) - CGRectGetMinY(keyboardFrame)))
        : 0;
}

static BOOL alookIsTauriRootController(UIViewController *viewController) {
    Class taoViewController = NSClassFromString(@"TaoUIViewController");
    return taoViewController != Nil && [viewController isKindOfClass:taoViewController];
}

@interface AlookCommunityRootScrollDelegate : NSObject <UIScrollViewDelegate>
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, weak) UIView *hostView;
@property (nonatomic, weak) id<UIScrollViewDelegate> previousDelegate;
@property (nonatomic) BOOL correcting;
- (void)constrainRootScrollView:(UIScrollView *)scrollView;
@end

@implementation AlookCommunityRootScrollDelegate

- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.previousDelegate respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
    id<UIScrollViewDelegate> previous = self.previousDelegate;
    if ([previous respondsToSelector:selector]) return previous;
    return [super forwardingTargetForSelector:selector];
}

- (void)scrollViewDidScroll:(UIScrollView *)scrollView {
    id<UIScrollViewDelegate> previous = self.previousDelegate;
    if ([previous respondsToSelector:_cmd]) [previous scrollViewDidScroll:scrollView];
    [self constrainRootScrollView:scrollView];
}

- (void)constrainRootScrollView:(UIScrollView *)scrollView {
    WKWebView *webView = self.webView;
    UIView *host = self.hostView;
    NSString *path = webView.URL.path;
    if (self.correcting || webView == nil || host == nil || webView.superview != host ||
        scrollView != webView.scrollView ||
        scrollView.delegate != self ||
        !([path isEqualToString:@"/c"] || [path hasPrefix:@"/c/"]) ||
        CGPointEqualToPoint(scrollView.contentOffset, CGPointZero)) return;

    self.correcting = YES;
    [scrollView setContentOffset:CGPointZero animated:NO];
    self.correcting = NO;
}

@end

@interface AlookCommunityRootURLObserver : NSObject
@property (nonatomic, strong, readonly) WKWebView *webView;
@property (nonatomic, weak) AlookCommunityRootScrollDelegate *scrollDelegate;
@property (nonatomic) BOOL observing;
- (instancetype)initWithWebView:(WKWebView *)webView delegate:(AlookCommunityRootScrollDelegate *)delegate;
- (void)startObserving;
@end

@implementation AlookCommunityRootURLObserver

- (instancetype)initWithWebView:(WKWebView *)webView delegate:(AlookCommunityRootScrollDelegate *)delegate {
    self = [super init];
    if (self) {
        _webView = webView;
        _scrollDelegate = delegate;
    }
    return self;
}

- (void)startObserving {
    if (_observing) return;
    [_webView addObserver:self forKeyPath:@"URL"
                 options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew
                 context:(void *)kAlookCommunityRootURLObserversKey];
    _observing = YES;
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                       change:(NSDictionary<NSKeyValueChangeKey, id> *)change context:(void *)context {
    if (context == kAlookCommunityRootURLObserversKey && object == self.webView) {
        [self.scrollDelegate constrainRootScrollView:self.webView.scrollView];
        return;
    }
    [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
}

- (void)dealloc {
    if (_observing) [_webView removeObserver:self forKeyPath:@"URL" context:(void *)kAlookCommunityRootURLObserversKey];
}

@end

static void alookInstallCommunityRootScrollLock(UIView *host, WKWebView *webView) {
    if (webView.superview != host) return;
    NSMutableArray<AlookCommunityRootURLObserver *> *observers = objc_getAssociatedObject(host, kAlookCommunityRootURLObserversKey);
    if (observers == nil) {
        observers = [NSMutableArray array];
        objc_setAssociatedObject(host, kAlookCommunityRootURLObserversKey, observers, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    BOOL observing = NO;
    for (AlookCommunityRootURLObserver *observer in [observers copy]) {
        if (observer.webView.superview != host) [observers removeObject:observer];
        else if (observer.webView == webView) observing = YES;
    }
    if (observing) return;

    AlookCommunityRootScrollDelegate *delegate = objc_getAssociatedObject(webView, kAlookCommunityRootScrollDelegateKey);
    if (delegate == nil) {
        delegate = [[AlookCommunityRootScrollDelegate alloc] init];
        delegate.webView = webView;
        delegate.previousDelegate = webView.scrollView.delegate;
        objc_setAssociatedObject(webView, kAlookCommunityRootScrollDelegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        webView.scrollView.delegate = delegate;
    }
    delegate.hostView = host;
    AlookCommunityRootURLObserver *observer = [[AlookCommunityRootURLObserver alloc] initWithWebView:webView delegate:delegate];
    [observers addObject:observer];
    [observer startObserving];
}

static NSDictionary *alookMeasureKeyboardSnapshot(UIViewController *controller, WKWebView *webView) {
    UIView *host = controller.view;
    CGRect guideFrame = host.keyboardLayoutGuide.layoutFrame;
    UIView *tracker = objc_getAssociatedObject(controller, kAlookKeyboardLayoutViewKey);
    CALayer *presentation = tracker.layer.presentationLayer;
    if (presentation != nil) {
        CGFloat top = CGRectGetMaxY(presentation.frame);
        guideFrame = CGRectMake(guideFrame.origin.x, top, guideFrame.size.width,
                                MAX(0, CGRectGetMaxY(host.bounds) - top));
    }
    CGRect keyboardFrame = [webView convertRect:guideFrame fromView:host];
    CGRect bounds = webView.bounds;
    CGFloat bottomInset = alookKeyboardBottomInset(bounds, keyboardFrame,
        guideFrame, host.safeAreaLayoutGuide.layoutFrame);
    return @{
        @"bottomInset": @(bottomInset),
        @"viewportWidth": @(bounds.size.width)
    };
}

@interface AlookKeyboardSnapshotPublisher : NSObject
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, strong) NSDictionary *pendingSnapshot;
@property (nonatomic, strong) NSDictionary *publishedSnapshot;
@property (nonatomic) BOOL evaluating;
- (void)enqueueSnapshot:(NSDictionary *)snapshot;
- (void)deliverLatest;
@end

@implementation AlookKeyboardSnapshotPublisher

- (void)enqueueSnapshot:(NSDictionary *)snapshot {
    self.pendingSnapshot = [snapshot isEqualToDictionary:self.publishedSnapshot] ? nil : snapshot;
    [self deliverLatest];
}

- (void)deliverLatest {
    WKWebView *webView = self.webView;
    if (self.evaluating || self.pendingSnapshot == nil || webView == nil) return;
    NSDictionary *snapshot = self.pendingSnapshot;
    self.pendingSnapshot = nil;
    self.publishedSnapshot = snapshot;
    self.evaluating = YES;
    NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:nil];
    NSString *detail = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:
        @"window.dispatchEvent(new CustomEvent('alook:keyboard-change',{detail:%@}))", detail];
    [webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        self.evaluating = NO;
        if (error != nil) self.publishedSnapshot = nil;
        [self deliverLatest];
    }];
}

@end

static void alookPublishKeyboardSnapshots(UIViewController *controller, BOOL animating) {
    if (!alookIsTauriRootController(controller) || !controller.isViewLoaded) return;
    for (UIView *subview in controller.view.subviews) {
        if (![subview isKindOfClass:[WKWebView class]]) continue;
        WKWebView *webView = (WKWebView *)subview;
        NSMutableDictionary *snapshot = [alookMeasureKeyboardSnapshot(controller, webView) mutableCopy];
        snapshot[@"isAnimating"] = @(animating);
        AlookKeyboardSnapshotPublisher *publisher = objc_getAssociatedObject(webView, kAlookPublishedKeyboardSnapshotKey);
        if (publisher == nil) {
            publisher = [[AlookKeyboardSnapshotPublisher alloc] init];
            publisher.webView = webView;
            objc_setAssociatedObject(webView, kAlookPublishedKeyboardSnapshotKey, publisher, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [publisher enqueueSnapshot:snapshot];
    }
}

@interface AlookKeyboardLayoutView : UIView
@property (nonatomic, weak) UIViewController *viewController;
@property (nonatomic, strong) CADisplayLink *displayLink;
@property (nonatomic) CFTimeInterval animationDeadline;
@property (nonatomic) CFTimeInterval animationTimeout;
- (void)keyboardWillChange:(NSNotification *)notification;
@end

@implementation AlookKeyboardLayoutView

- (void)keyboardWillChange:(NSNotification *)notification {
    NSTimeInterval duration = [notification.userInfo[UIKeyboardAnimationDurationUserInfoKey] doubleValue];
    self.animationDeadline = CACurrentMediaTime() + duration;
    self.animationTimeout = self.animationDeadline + 1.0;
    if (self.displayLink == nil) {
        self.displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(sampleKeyboard:)];
        [self.displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    }
}

- (void)sampleKeyboard:(CADisplayLink *)link {
    UIViewController *controller = self.viewController;
    CALayer *presentation = self.layer.presentationLayer;
    BOOL settled = presentation == nil || fabs(CGRectGetMaxY(presentation.frame) - CGRectGetMaxY(self.frame)) < 0.25;
    BOOL animating = controller != nil && self.window != nil
        && (link.timestamp < self.animationDeadline || (!settled && link.timestamp < self.animationTimeout));
    alookPublishKeyboardSnapshots(controller, animating);
    if (!animating) {
        [self.displayLink invalidate];
        self.displayLink = nil;
    }
}

- (void)didMoveToWindow {
    [super didMoveToWindow];
    if (self.window == nil) {
        [self.displayLink invalidate];
        self.displayLink = nil;
    }
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [self.displayLink invalidate];
}

- (void)layoutSubviews {
    [super layoutSubviews];
    UIViewController *controller = self.viewController;
    if (controller != nil && self.superview == controller.view && self.displayLink == nil) alookPublishKeyboardSnapshots(controller, NO);
}

@end

static void alookInstallKeyboardLayout(UIViewController *controller) {
    if (!alookIsTauriRootController(controller)) return;
    UIView *host = controller.view;
    AlookKeyboardLayoutView *previous = objc_getAssociatedObject(controller, kAlookKeyboardLayoutViewKey);
    if (previous.superview == host) return;
    [previous removeFromSuperview];
    AlookKeyboardLayoutView *content = [[AlookKeyboardLayoutView alloc] init];
    content.viewController = controller;
    [NSNotificationCenter.defaultCenter addObserver:content selector:@selector(keyboardWillChange:)
        name:UIKeyboardWillChangeFrameNotification object:nil];
    content.accessibilityIdentifier = @"alook.keyboard-layout";
    content.accessibilityElementsHidden = YES;
    content.userInteractionEnabled = NO;
    content.opaque = NO;
    content.backgroundColor = UIColor.clearColor;
    content.translatesAutoresizingMaskIntoConstraints = NO;
    [host insertSubview:content atIndex:0];
    NSLayoutConstraint *bottom = [content.bottomAnchor constraintEqualToAnchor:host.keyboardLayoutGuide.topAnchor];
    bottom.priority = UILayoutPriorityRequired - 1;
    [NSLayoutConstraint activateConstraints:@[
        [content.topAnchor constraintEqualToAnchor:host.safeAreaLayoutGuide.topAnchor],
        [content.leadingAnchor constraintEqualToAnchor:host.safeAreaLayoutGuide.leadingAnchor],
        [content.trailingAnchor constraintEqualToAnchor:host.safeAreaLayoutGuide.trailingAnchor],
        [content.heightAnchor constraintGreaterThanOrEqualToConstant:0],
        bottom
    ]];
    objc_setAssociatedObject(controller, kAlookKeyboardLayoutViewKey, content, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [host setNeedsLayout];
}

static UIView *alookStartupHostView(UIViewController *viewController) {
    if ([gAlookStartupOverlay.superview isKindOfClass:[UIWindow class]]) {
        return gAlookStartupOverlay.superview;
    }
    return viewController.view.window ?: viewController.view;
}

static BOOL alookEffectiveDarkTheme(UIViewController *viewController) {
    NSNumber *webTheme = objc_getAssociatedObject(viewController, kAlookWebDarkThemeKey);
    if (webTheme != nil) return webTheme.boolValue;
    return viewController.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
}

static UIView *alookCreateStartupOverlay(void) {
    UIView *overlay = [[UIView alloc] initWithFrame:CGRectZero];
    overlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    overlay.userInteractionEnabled = NO;
    overlay.accessibilityElementsHidden = YES;
    UIImageView *logo = [[UIImageView alloc] initWithImage:[UIImage imageNamed:@"SplashIcon"]];
    logo.tag = kAlookStartupLogoTag;
    logo.contentMode = UIViewContentModeScaleAspectFit;
    [overlay addSubview:logo];
    return overlay;
}

static void alookAttachStartupOverlay(UIView *overlay, UIView *host, BOOL isDark) {
    if (overlay == nil || host == nil) return;
    if (overlay.superview != host) {
        [overlay removeFromSuperview];
        [host addSubview:overlay];
    }
    overlay.frame = host.bounds;
    overlay.backgroundColor = isDark ? alookDarkColor() : alookLightColor();
    UIView *logo = [overlay viewWithTag:kAlookStartupLogoTag];
    CGFloat size = 106.0;
    CGRect safeBounds = UIEdgeInsetsInsetRect(overlay.bounds, host.safeAreaInsets);
    logo.frame = CGRectMake(
        CGRectGetMidX(safeBounds) - size / 2.0,
        CGRectGetMidY(safeBounds) - size / 2.0,
        size,
        size
    );
    if (gAlookStartupFailed) {
        logo.hidden = YES;
        overlay.accessibilityElementsHidden = NO;
        UILabel *message = (UILabel *)[overlay viewWithTag:kAlookStartupErrorTag];
        if (message == nil) {
            message = [[UILabel alloc] initWithFrame:CGRectZero];
            message.tag = kAlookStartupErrorTag;
            message.text = @"Alook could not start. Close and reopen the app.";
            message.textAlignment = NSTextAlignmentCenter;
            message.numberOfLines = 0;
            message.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
            message.adjustsFontForContentSizeCategory = YES;
            message.isAccessibilityElement = YES;
            [overlay addSubview:message];
        }
        message.textColor = isDark ? UIColor.whiteColor : UIColor.blackColor;
        message.frame = CGRectInset(safeBounds, 24.0, 24.0);
    }
    [host bringSubviewToFront:overlay];
}

static void alookInstallStartupOverlayInWindow(UIWindow *window) {
    if (gAlookStartupCompleted || window == nil) return;
    if (gAlookStartupOverlay == nil) gAlookStartupOverlay = alookCreateStartupOverlay();
    BOOL isDark = window.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
    alookAttachStartupOverlay(gAlookStartupOverlay, window, isDark);
}

static void alookApplyTheme(UIViewController *viewController, BOOL isDark) {
    NSNumber *resolvedTheme = objc_getAssociatedObject(viewController, kAlookResolvedDarkThemeKey);
    BOOL statusBarNeedsUpdate = resolvedTheme == nil || resolvedTheme.boolValue != isDark;
    objc_setAssociatedObject(
        viewController,
        kAlookResolvedDarkThemeKey,
        @(isDark),
        OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
    UIColor *webBackground = objc_getAssociatedObject(viewController, kAlookWebBackgroundKey);
    viewController.view.backgroundColor = webBackground ?: (isDark ? alookDarkColor() : alookLightColor());
    if (statusBarNeedsUpdate) [viewController setNeedsStatusBarAppearanceUpdate];
}

static UIView *alookInstallStartupOverlay(UIViewController *viewController) {
    if (gAlookStartupCompleted ||
        [objc_getAssociatedObject(viewController, kAlookStartupCompletedKey) boolValue]) return nil;
    UIView *overlay = objc_getAssociatedObject(viewController, kAlookStartupOverlayKey);
    if (overlay != nil) return overlay;

    UIView *host = alookStartupHostView(viewController);
    overlay = gAlookStartupOverlay ?: alookCreateStartupOverlay();
    gAlookStartupOverlay = overlay;
    BOOL isDark = viewController.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
    alookAttachStartupOverlay(overlay, host, isDark);
    objc_setAssociatedObject(
        viewController,
        kAlookStartupOverlayKey,
        overlay,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
    return overlay;
}

static void alookLayoutStartupOverlay(UIViewController *viewController, UIView *overlay) {
    BOOL isDark = viewController.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
    UIView *host = alookStartupHostView(viewController);
    alookAttachStartupOverlay(overlay, host, isDark);
}

static void alookPrepareStartupOverlay(UIViewController *viewController) {
    if (!alookIsTauriRootController(viewController)) return;
    alookApplyTheme(viewController, alookEffectiveDarkTheme(viewController));
    UIView *overlay = alookInstallStartupOverlay(viewController);
    if (overlay != nil) alookLayoutStartupOverlay(viewController, overlay);
}

static void alookFinishStartupOverlay(UIViewController *viewController) {
    if (viewController == nil || gAlookStartupFailed) return;
    UIView *overlay = objc_getAssociatedObject(viewController, kAlookStartupOverlayKey);
    [overlay removeFromSuperview];
    if (overlay == gAlookStartupOverlay) gAlookStartupOverlay = nil;
    gAlookStartupCompleted = YES;
    objc_setAssociatedObject(viewController, kAlookStartupOverlayKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(
        viewController,
        kAlookStartupCompletedKey,
        @YES,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
}

static NSString *const kThemeObserverScript =
    @"(function(){"
    "if(window.__alookThemeObserverInstalled)return;"
    "window.__alookThemeObserverInstalled=true;"
    "function background(){"
    "if(!document.body)return null;"
    "var c=document.createElement('canvas');c.width=c.height=1;"
    "var x=c.getContext('2d');if(!x)return null;"
    "var m=document.querySelector('meta[name=theme-color]');"
    "x.fillStyle=m&&m.content?m.content:getComputedStyle(document.body).backgroundColor;"
    "x.fillRect(0,0,1,1);var p=x.getImageData(0,0,1,1).data;"
    "if(p[3]!==255)return null;"
    "return '#'+Array.from(p).slice(0,3).map(function(v){"
    "return v.toString(16).padStart(2,'0');}).join('');}"
    "function sync(){var r=document.documentElement;"
    "var d=r.classList.contains('dark');"
    "if(!d&&!r.classList.contains('light'))return;"
    "window.webkit.messageHandlers.alookTheme.postMessage({theme:d?'dark':'light',background:background()});}"
    "document.addEventListener('DOMContentLoaded',sync);"
    "window.addEventListener('load',sync);"
    "window.addEventListener('alook:theme-color-change',sync);"
    "sync();"
    "new MutationObserver(sync).observe(document.documentElement,"
    "{attributes:true,attributeFilter:['class','data-tn-mode']});"
    "})();";

@interface AlookThemeHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) UIViewController *viewController;
@property (nonatomic, weak) WKWebView *webView;
@end

@implementation AlookThemeHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    WKWebView *webView = self.webView;
    UIViewController *controller = self.viewController;
    if (webView == nil || controller == nil || message.webView != webView ||
        !message.frameInfo.isMainFrame || webView.superview != controller.view ||
        objc_getAssociatedObject(webView, kAlookThemeHandlerKey) != self ||
        ![message.name isEqualToString:@"alookTheme"]) return;
    NSDictionary *payload = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
    NSString *theme = payload != nil ? payload[@"theme"] : message.body;
    if (![theme isKindOfClass:NSString.class] ||
        (![theme isEqualToString:@"dark"] && ![theme isEqualToString:@"light"])) return;
    NSString *hex = payload[@"background"];
    UIColor *background = nil;
    if ([hex isKindOfClass:NSString.class] && hex.length == 7 && [hex hasPrefix:@"#"]) {
        unsigned int rgb = 0;
        NSScanner *scanner = [NSScanner scannerWithString:[hex substringFromIndex:1]];
        if ([scanner scanHexInt:&rgb] && scanner.isAtEnd) {
            background = [UIColor colorWithRed:((rgb >> 16) & 255) / 255.0
                                        green:((rgb >> 8) & 255) / 255.0
                                         blue:(rgb & 255) / 255.0 alpha:1.0];
        }
    }
    BOOL isDark = [theme isEqualToString:@"dark"];
    __weak WKWebView *capturedWebView = webView;
    __weak UIViewController *capturedController = controller;
    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *currentWebView = capturedWebView;
        UIViewController *viewController = capturedController;
        if (currentWebView == nil || viewController == nil ||
            self.webView != currentWebView || self.viewController != viewController ||
            currentWebView.superview != viewController.view ||
            objc_getAssociatedObject(currentWebView, kAlookThemeHandlerKey) != self) return;
        objc_setAssociatedObject(
            viewController,
            kAlookWebDarkThemeKey,
            @(isDark),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC
        );
        objc_setAssociatedObject(viewController, kAlookWebBackgroundKey, background, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        alookApplyTheme(viewController, isDark);
    });
}

@end

static void alookInstallThemeObserver(UIViewController *controller, WKWebView *webView) {
    AlookThemeHandler *handler = objc_getAssociatedObject(webView, kAlookThemeHandlerKey);
    if (handler != nil) {
        handler.viewController = controller;
        return;
    }
    handler = [[AlookThemeHandler alloc] init];
    handler.viewController = controller;
    handler.webView = webView;
    [webView.configuration.userContentController addScriptMessageHandler:handler name:@"alookTheme"];
    WKUserScript *script = [[WKUserScript alloc]
        initWithSource:kThemeObserverScript
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
        forMainFrameOnly:YES];
    [webView.configuration.userContentController addUserScript:script];
    objc_setAssociatedObject(webView, kAlookThemeHandlerKey, handler, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

@interface AlookGeometryHandler : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, weak) UIViewController *viewController;
@property (nonatomic, weak) WKWebView *webView;
@end

@implementation AlookGeometryHandler
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    WKWebView *webView = self.webView;
    if (webView == nil || message.webView != webView || !message.frameInfo.isMainFrame ||
        ![message.body isEqual:@"snapshot"]) {
        replyHandler(nil, @"Geometry view unavailable");
        return;
    }
    replyHandler(alookMeasureGeometry(self.viewController, webView) ?: NSNull.null, nil);
}
@end

@interface AlookKeyboardHandler : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, weak) UIViewController *viewController;
@end

@implementation AlookKeyboardHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    WKWebView *webView = self.webView;
    UIViewController *controller = self.viewController;
    if (webView == nil || controller == nil || webView.superview != controller.view ||
        message.webView != webView || ![message.frameInfo isMainFrame]) {
        replyHandler(nil, @"Keyboard view unavailable");
        return;
    }
    if (![message.body isEqual:@"snapshot"]) {
        replyHandler(nil, @"Invalid keyboard command");
        return;
    }
    replyHandler(alookMeasureKeyboardSnapshot(controller, webView), nil);
}

@end

@implementation UIViewController (AlookSafeArea)

+ (BOOL)alook_finishStartupOverlayForController:(UIViewController *)controller
                                      webView:(WKWebView *)webView {
    if (![NSThread isMainThread] || gAlookStartupFailed) return NO;
    if (!alookIsTauriRootController(controller) ||
        ![controller.view.subviews containsObject:webView]) return NO;
    if ([objc_getAssociatedObject(controller, kAlookStartupCompletedKey) boolValue]) return YES;
    alookPrepareStartupOverlay(controller);
    if (objc_getAssociatedObject(controller, kAlookStartupOverlayKey) == nil) return NO;
    alookFinishStartupOverlay(controller);
    return YES;
}

+ (void)alook_showStartupInitializationError {
    if (![NSThread isMainThread] || gAlookStartupCompleted) return;
    gAlookStartupFailed = YES;
    UIView *host = gAlookStartupOverlay.superview;
    if (host != nil) {
        BOOL isDark = host.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
        alookAttachStartupOverlay(gAlookStartupOverlay, host, isDark);
    }
}

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [[NSNotificationCenter defaultCenter]
            addObserverForName:UIWindowDidBecomeVisibleNotification
            object:nil
            queue:nil
            usingBlock:^(NSNotification *notification) {
                UIWindow *window = [notification.object isKindOfClass:[UIWindow class]]
                    ? (UIWindow *)notification.object
                    : nil;
                if (window != nil && window.windowLevel == UIWindowLevelNormal) {
                    alookInstallStartupOverlayInWindow(window);
                }
            }];

        Method originalDidLoad = class_getInstanceMethod(self, @selector(viewDidLoad));
        Method swizzledDidLoad = class_getInstanceMethod(self, @selector(alook_viewDidLoad));
        method_exchangeImplementations(originalDidLoad, swizzledDidLoad);

        Method original = class_getInstanceMethod(self, @selector(viewDidLayoutSubviews));
        Method swizzled = class_getInstanceMethod(self, @selector(alook_viewDidLayoutSubviews));
        method_exchangeImplementations(original, swizzled);

        Method originalDidAppear = class_getInstanceMethod(self, @selector(viewDidAppear:));
        Method swizzledDidAppear = class_getInstanceMethod(self, @selector(alook_viewDidAppear:));
        method_exchangeImplementations(originalDidAppear, swizzledDidAppear);

        Method originalStatusBar = class_getInstanceMethod(self, @selector(preferredStatusBarStyle));
        Method swizzledStatusBar = class_getInstanceMethod(self, @selector(alook_preferredStatusBarStyle));
        method_exchangeImplementations(originalStatusBar, swizzledStatusBar);
    });
}

- (UIStatusBarStyle)alook_preferredStatusBarStyle {
    NSNumber *resolvedTheme = objc_getAssociatedObject(self, kAlookResolvedDarkThemeKey);
    if (resolvedTheme == nil) return [self alook_preferredStatusBarStyle];
    return resolvedTheme.boolValue ? UIStatusBarStyleLightContent : UIStatusBarStyleDarkContent;
}

- (void)alook_viewDidLoad {
    [self alook_viewDidLoad];
    alookPrepareStartupOverlay(self);
}

- (void)alook_viewDidAppear:(BOOL)animated {
    [self alook_viewDidAppear:animated];
    alookPrepareStartupOverlay(self);
}

- (void)alook_viewDidLayoutSubviews {
    [self alook_viewDidLayoutSubviews];
    BOOL isTauriRoot = alookIsTauriRootController(self);
    if (isTauriRoot) {
        alookInstallKeyboardLayout(self);
        alookPrepareStartupOverlay(self);
    }
    UIEdgeInsets insets = self.view.safeAreaInsets;
    for (UIView *subview in self.view.subviews) {
        if ([subview isKindOfClass:[WKWebView class]]) {
            CGRect bounds = self.view.bounds;
            CGRect contentFrame = alookNativeContentFrame(bounds, insets, isTauriRoot);

            WKWebView *webView = (WKWebView *)subview;
            if (isTauriRoot) {
                webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
                alookInstallCommunityRootScrollLock(self.view, webView);
                NSDictionary *previousGeometry = objc_getAssociatedObject(webView, kAlookGeometryKey);
                if (previousGeometry == nil) {
                    AlookGeometryHandler *handler = [[AlookGeometryHandler alloc] init];
                    handler.viewController = self;
                    handler.webView = webView;
                    [webView.configuration.userContentController
                        addScriptMessageHandlerWithReply:handler
                        contentWorld:WKContentWorld.pageWorld
                        name:@"alookGeometry"];
                    AlookKeyboardHandler *keyboard = [[AlookKeyboardHandler alloc] init];
                    keyboard.webView = webView;
                    keyboard.viewController = self;
                    [webView.configuration.userContentController
                        addScriptMessageHandlerWithReply:keyboard
                        contentWorld:WKContentWorld.pageWorld
                        name:@"alookKeyboard"];
                    objc_setAssociatedObject(webView, kAlookGeometryKey, @{}, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                }
            }
            if (!CGRectEqualToRect(webView.frame, contentFrame)) webView.frame = contentFrame;
            if (isTauriRoot) {
                NSDictionary *geometry = alookMeasureGeometry(self, webView);
                NSDictionary *previousGeometry = objc_getAssociatedObject(webView, kAlookGeometryKey);
                if (geometry != nil && ![geometry isEqualToDictionary:previousGeometry]) {
                    objc_setAssociatedObject(webView, kAlookGeometryKey, geometry, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                    [webView evaluateJavaScript:@"window.dispatchEvent(new Event('alook:geometry-change'))" completionHandler:nil];
                }
            }
            alookInstallThemeObserver(self, webView);

            alookApplyTheme(self, alookEffectiveDarkTheme(self));
        }
    }
    AlookKeyboardLayoutView *tracker = objc_getAssociatedObject(self, kAlookKeyboardLayoutViewKey);
    if (isTauriRoot && tracker.displayLink == nil) alookPublishKeyboardSnapshots(self, NO);
}

@end

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}
