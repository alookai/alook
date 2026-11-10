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
static const void *kAlookKeyboardLayoutKey = &kAlookKeyboardLayoutKey;
static const void *kAlookCommunityRootScrollDelegateKey = &kAlookCommunityRootScrollDelegateKey;
static const void *kAlookCommunityRootURLObserversKey = &kAlookCommunityRootURLObserversKey;
static const void *kAlookStartupOverlayKey = &kAlookStartupOverlayKey;
static const void *kAlookStartupCompletedKey = &kAlookStartupCompletedKey;
static const NSInteger kAlookStartupLogoTag = 8738;
static const NSInteger kAlookStartupErrorTag = 8739;
static UIView *gAlookStartupOverlay = nil;
static BOOL gAlookStartupCompleted = NO;
static BOOL gAlookNativeCreationReady = NO;
static BOOL gAlookStartupFailed = NO;

static BOOL alookIsTauriRootController(UIViewController *viewController);

static CGRect alookNativeContentFrame(CGRect bounds, UIEdgeInsets systemInsets, BOOL isTauriRoot) {
    if (isTauriRoot) return bounds;
    return CGRectMake(systemInsets.left, systemInsets.top,
        bounds.size.width - systemInsets.left - systemInsets.right,
        bounds.size.height - systemInsets.top - systemInsets.bottom);
}

static UIEdgeInsets alookGeometryInsets(CGRect bounds, CGRect safe, CGFloat bottomReduction) {
    UIEdgeInsets insets;
    insets.left = MIN(bounds.size.width, MAX(0, CGRectGetMinX(safe) - CGRectGetMinX(bounds)));
    insets.right = MIN(bounds.size.width - insets.left, MAX(0, CGRectGetMaxX(bounds) - CGRectGetMaxX(safe)));
    insets.top = MIN(bounds.size.height, MAX(10.0, CGRectGetMinY(safe) - CGRectGetMinY(bounds)));
    insets.bottom = MIN(bounds.size.height - insets.top, MAX(0, 20.0 - bottomReduction));
    return insets;
}

static BOOL alookKeyboardGuideVisible(CGRect guideFrame, CGRect safeAreaFrame) {
    return !CGRectIsEmpty(guideFrame) && CGRectGetMinY(guideFrame) < CGRectGetMaxY(safeAreaFrame);
}

static NSDictionary *alookMeasureGeometry(UIViewController *controller, WKWebView *webView) {
    if (!alookIsTauriRootController(controller) || webView.superview != controller.view ||
        webView.window == nil || CGRectIsEmpty(webView.bounds)) return nil;
    CGRect bounds = webView.bounds;
    CGRect safe = [webView convertRect:controller.view.safeAreaLayoutGuide.layoutFrame fromView:controller.view];
    CGFloat bottomReduction = MAX(0, CGRectGetMaxY(controller.view.bounds) - CGRectGetMaxY(webView.frame));
    UIEdgeInsets insets = alookGeometryInsets(bounds, safe, bottomReduction);
    return @{ @"top": @(insets.top), @"right": @(insets.right), @"bottom": @(insets.bottom), @"left": @(insets.left),
              @"viewportWidth": @(bounds.size.width), @"viewportHeight": @(bounds.size.height), @"caption": @NO,
              @"windowHeight": @(controller.view.bounds.size.height),
              @"windowBottom": @(MIN(20.0, MAX(0, controller.view.bounds.size.height - insets.top))) };
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

static void alookInstallCommunityRootScrollLock(UIViewController *controller, WKWebView *webView) {
    if (!alookIsTauriRootController(controller)) return;
    UIView *host = controller.view;
    if (host == nil || webView.superview != host) return;
    webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
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

@interface AlookKeyboardLayout : NSObject
@property (nonatomic, weak) UIView *hostView;
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, strong) NSArray<NSLayoutConstraint *> *constraints;
@property (nonatomic, strong) NSLayoutConstraint *bottomConstraint;
@property (nonatomic) BOOL keyboardVisible;
- (void)updateSafeArea;
- (void)keyboardWillChange:(NSNotification *)notification;
@end

@implementation AlookKeyboardLayout

- (void)updateSafeArea {
    if (@available(iOS 17.0, *)) return;
    CGFloat correction = self.keyboardVisible ? 0 : self.hostView.safeAreaInsets.bottom;
    if (self.bottomConstraint.constant != correction) self.bottomConstraint.constant = correction;
}

- (void)keyboardWillChange:(NSNotification *)notification {
    UIView *host = self.hostView;
    if (host.window == nil || self.webView.superview != host) return;
    NSNumber *local = notification.userInfo[UIKeyboardIsLocalUserInfoKey];
    if (local != nil && !local.boolValue) return;
    CGRect frame = [host.window.screen.coordinateSpace
        convertRect:[notification.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue] toCoordinateSpace:host];
    self.keyboardVisible = alookKeyboardGuideVisible(frame, host.safeAreaLayoutGuide.layoutFrame)
        && CGRectGetMaxY(frame) >= CGRectGetMaxY(host.bounds)
        && CGRectGetWidth(frame) >= CGRectGetWidth(host.bounds);
    [self updateSafeArea];
    NSTimeInterval duration = [notification.userInfo[UIKeyboardAnimationDurationUserInfoKey] doubleValue];
    UIViewAnimationOptions curve = (UIViewAnimationOptions)([notification.userInfo[UIKeyboardAnimationCurveUserInfoKey] unsignedIntegerValue] << 16);
    [UIView animateWithDuration:duration delay:0
        options:curve | UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
        animations:^{ [host layoutIfNeeded]; } completion:nil];
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [NSLayoutConstraint deactivateConstraints:_constraints];
}

@end

static void alookInstallKeyboardLayout(UIViewController *controller, WKWebView *webView) {
    if (!alookIsTauriRootController(controller) || webView.superview != controller.view) return;
    UIView *host = controller.view;
    AlookKeyboardLayout *previous = objc_getAssociatedObject(webView, kAlookKeyboardLayoutKey);
    if (previous.hostView == host) {
        [previous updateSafeArea];
        return;
    }
    if (previous != nil) [NSLayoutConstraint deactivateConstraints:previous.constraints];
    AlookKeyboardLayout *layout = [[AlookKeyboardLayout alloc] init];
    layout.hostView = host;
    layout.webView = webView;
    if (@available(iOS 17.0, *)) {
        host.keyboardLayoutGuide.usesBottomSafeArea = NO;
    } else {
        layout.keyboardVisible = alookKeyboardGuideVisible(host.keyboardLayoutGuide.layoutFrame,
            host.safeAreaLayoutGuide.layoutFrame);
        [NSNotificationCenter.defaultCenter addObserver:layout selector:@selector(keyboardWillChange:)
            name:UIKeyboardWillChangeFrameNotification object:nil];
    }
    webView.translatesAutoresizingMaskIntoConstraints = NO;
    layout.bottomConstraint = [webView.bottomAnchor constraintEqualToAnchor:host.keyboardLayoutGuide.topAnchor];
    layout.bottomConstraint.priority = UILayoutPriorityRequired - 1;
    [layout updateSafeArea];
    layout.constraints = @[
        [webView.topAnchor constraintEqualToAnchor:host.topAnchor],
        [webView.leadingAnchor constraintEqualToAnchor:host.leadingAnchor],
        [webView.trailingAnchor constraintEqualToAnchor:host.trailingAnchor],
        [webView.heightAnchor constraintGreaterThanOrEqualToConstant:0],
        layout.bottomConstraint
    ];
    [NSLayoutConstraint activateConstraints:layout.constraints];
    objc_setAssociatedObject(webView, kAlookKeyboardLayoutKey, layout, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
        CGRectGetMidX(overlay.bounds) - size / 2.0,
        CGRectGetMidY(overlay.bounds) - size / 2.0,
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
    "if(!document.body||!document.body.style)return null;"
    "var published=document.body.style.getPropertyValue('--app-edge-fade-color').trim();"
    "if(!published)return null;"
    "var c=document.createElement('canvas');c.width=c.height=1;"
    "var x=c.getContext('2d');if(!x)return null;"
    "x.fillStyle='transparent';x.fillStyle=published;"
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
    replyHandler(@{ @"resizesViewport": @YES }, nil);
}

@end

@implementation UIViewController (AlookSafeArea)

+ (BOOL)alook_finishStartupOverlayForController:(UIViewController *)controller
                                      webView:(WKWebView *)webView {
    if (![NSThread isMainThread] || gAlookStartupFailed) return NO;
    if (!alookIsTauriRootController(controller) ||
        ![controller.view.subviews containsObject:webView]) return NO;
    webView.opaque = NO;
    webView.backgroundColor = UIColor.clearColor;
    webView.scrollView.backgroundColor = UIColor.clearColor;
    webView.underPageBackgroundColor = UIColor.clearColor;
    if ([objc_getAssociatedObject(controller, kAlookStartupCompletedKey) boolValue]) return YES;
    alookPrepareStartupOverlay(controller);
    if (objc_getAssociatedObject(controller, kAlookStartupOverlayKey) == nil) return NO;
    gAlookNativeCreationReady = YES;
    return YES;
}

+ (NSInteger)alook_startupDocumentForWebView:(WKWebView *)webView {
    NSURL *url = webView.URL;
    if (url == nil || url.user != nil || url.password != nil || url.query != nil) return 0;
    BOOL local = ([url.scheme isEqualToString:@"alook-recovery"] && [url.host isEqualToString:@"localhost"] && url.port == nil) ||
        ([url.scheme isEqualToString:@"http"] && [url.host isEqualToString:@"alook-recovery.localhost"] && (url.port == nil || url.port.integerValue == 80));
    if (!local) return 0;
    if ([url.path isEqualToString:@"/bootstrap"]) return 1;
    if ([url.path isEqualToString:@"/network-error"]) return 2;
    return 0;
}

+ (BOOL)alook_presentBootstrapForController:(UIViewController *)controller
                                   webView:(WKWebView *)webView {
    if (![NSThread isMainThread] || !gAlookNativeCreationReady) return NO;
    if (!alookIsTauriRootController(controller) || ![controller.view.subviews containsObject:webView]) return NO;
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
        alookPrepareStartupOverlay(self);
    }
    UIEdgeInsets insets = self.view.safeAreaInsets;
    for (UIView *subview in self.view.subviews) {
        if ([subview isKindOfClass:[WKWebView class]]) {
            CGRect bounds = self.view.bounds;
            CGRect contentFrame = alookNativeContentFrame(bounds, insets, isTauriRoot);

            WKWebView *webView = (WKWebView *)subview;
            if (isTauriRoot) {
                alookInstallKeyboardLayout(self, webView);
                alookInstallCommunityRootScrollLock(self, webView);
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
            if (!isTauriRoot && !CGRectEqualToRect(webView.frame, contentFrame)) webView.frame = contentFrame;
            if (isTauriRoot) {
                NSDictionary *geometry = alookMeasureGeometry(self, webView);
                NSDictionary *previousGeometry = objc_getAssociatedObject(webView, kAlookGeometryKey);
                if (geometry != nil && ![geometry isEqualToDictionary:previousGeometry]) {
                    objc_setAssociatedObject(webView, kAlookGeometryKey, geometry, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                    if (![geometry[@"top"] isEqual:previousGeometry[@"top"]]
                        || ![geometry[@"right"] isEqual:previousGeometry[@"right"]]
                        || ![geometry[@"bottom"] isEqual:previousGeometry[@"bottom"]]
                        || ![geometry[@"left"] isEqual:previousGeometry[@"left"]]) {
                        [webView evaluateJavaScript:@"window.dispatchEvent(new Event('alook:geometry-change'))" completionHandler:nil];
                    }
                }
            }
            alookInstallThemeObserver(self, webView);

            alookApplyTheme(self, alookEffectiveDarkTheme(self));
        }
    }
}

@end

int main(int argc, char * argv[]) {
	ffi::alook_startup_native_entry();
	ffi::start_app();
	return 0;
}
