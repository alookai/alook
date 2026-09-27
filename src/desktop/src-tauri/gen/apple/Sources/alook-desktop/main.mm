#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static UIColor *alookLightColor(void) {
    return [UIColor colorWithRed:1.0 green:1.0 blue:1.0 alpha:1.0];
}

static UIColor *alookDarkColor(void) {
    return [UIColor colorWithRed:0.063 green:0.051 blue:0.039 alpha:1.0];
}

static const void *kAlookResolvedDarkThemeKey = &kAlookResolvedDarkThemeKey;
static const void *kAlookWebDarkThemeKey = &kAlookWebDarkThemeKey;
static const void *kAlookStartupOverlayKey = &kAlookStartupOverlayKey;
static const void *kAlookStartupProbeStartedKey = &kAlookStartupProbeStartedKey;
static const void *kAlookStartupCompletedKey = &kAlookStartupCompletedKey;
static const NSInteger kAlookStartupLogoTag = 8738;

static BOOL alookIsTauriRootController(UIViewController *viewController) {
    Class taoViewController = NSClassFromString(@"TaoUIViewController");
    return taoViewController != Nil && [viewController isKindOfClass:taoViewController];
}

static UIView *alookStartupHostView(UIViewController *viewController) {
    return viewController.view.window ?: viewController.view;
}

static BOOL alookEffectiveDarkTheme(UIViewController *viewController) {
    NSNumber *webTheme = objc_getAssociatedObject(viewController, kAlookWebDarkThemeKey);
    if (webTheme != nil) return webTheme.boolValue;
    return viewController.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
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
    viewController.view.backgroundColor = isDark ? alookDarkColor() : alookLightColor();
    if (statusBarNeedsUpdate) [viewController setNeedsStatusBarAppearanceUpdate];
}

static UIView *alookInstallStartupOverlay(UIViewController *viewController) {
    if ([objc_getAssociatedObject(viewController, kAlookStartupCompletedKey) boolValue]) return nil;
    UIView *overlay = objc_getAssociatedObject(viewController, kAlookStartupOverlayKey);
    if (overlay != nil) return overlay;

    UIView *host = alookStartupHostView(viewController);
    overlay = [[UIView alloc] initWithFrame:host.bounds];
    overlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    overlay.userInteractionEnabled = NO;
    overlay.accessibilityElementsHidden = YES;
    UIImageView *logo = [[UIImageView alloc] initWithImage:[UIImage imageNamed:@"SplashIcon"]];
    logo.tag = kAlookStartupLogoTag;
    logo.contentMode = UIViewContentModeScaleAspectFit;
    [overlay addSubview:logo];
    [host addSubview:overlay];
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
    if (overlay.superview != host) {
        [overlay removeFromSuperview];
        [host addSubview:overlay];
    }
    overlay.frame = host.bounds;
    overlay.backgroundColor = isDark ? alookDarkColor() : alookLightColor();
    UIView *logo = [overlay viewWithTag:kAlookStartupLogoTag];
    CGFloat size = 106.0;
    logo.frame = CGRectMake(
        (overlay.bounds.size.width - size) / 2.0,
        (overlay.bounds.size.height - size) / 2.0,
        size,
        size
    );
    [host bringSubviewToFront:overlay];
}

static void alookPrepareStartupOverlay(UIViewController *viewController) {
    if (!alookIsTauriRootController(viewController)) return;
    UIView *overlay = alookInstallStartupOverlay(viewController);
    if (overlay != nil) alookLayoutStartupOverlay(viewController, overlay);
}

static void alookFinishStartupOverlay(UIViewController *viewController) {
    if (viewController == nil) return;
    UIView *overlay = objc_getAssociatedObject(viewController, kAlookStartupOverlayKey);
    [overlay removeFromSuperview];
    objc_setAssociatedObject(viewController, kAlookStartupOverlayKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(
        viewController,
        kAlookStartupCompletedKey,
        @YES,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC
    );
}

static void alookWaitForWebViewSurface(
    UIViewController *viewController,
    WKWebView *webView,
    NSInteger attempt
) {
    if (viewController == nil || webView == nil) return;
    if (attempt >= 200) {
        alookFinishStartupOverlay(viewController);
        return;
    }
    NSString *probe =
        @"(function(){"
        "if(location.hostname==='alook-recovery.localhost'&&location.pathname==='/bootstrap')return false;"
        "return document.readyState==='complete'&&!!document.body&&"
        "document.body.children.length>0&&document.body.getBoundingClientRect().height>0;"
        "})()";
    __weak UIViewController *weakViewController = viewController;
    __weak WKWebView *weakWebView = webView;
    [webView evaluateJavaScript:probe completionHandler:^(id result, NSError *error) {
        UIViewController *strongViewController = weakViewController;
        WKWebView *strongWebView = weakWebView;
        if (strongViewController == nil || strongWebView == nil) return;
        if (error == nil && [result respondsToSelector:@selector(boolValue)] && [result boolValue]) {
            dispatch_after(
                dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)),
                dispatch_get_main_queue(),
                ^{ alookFinishStartupOverlay(strongViewController); }
            );
            return;
        }
        dispatch_after(
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.05 * NSEC_PER_SEC)),
            dispatch_get_main_queue(),
            ^{ alookWaitForWebViewSurface(strongViewController, strongWebView, attempt + 1); }
        );
    }];
}

static NSString *const kThemeObserverScript =
    @"(function(){"
    "if(window.__alookThemeObserverInstalled)return;"
    "window.__alookThemeObserverInstalled=true;"
    "function sync(){var r=document.documentElement;"
    "var d=r.classList.contains('dark');"
    "if(!d&&!r.classList.contains('light'))return;"
    "window.webkit.messageHandlers.alookTheme.postMessage(d?'dark':'light');}"
    "sync();"
    "new MutationObserver(sync).observe(document.documentElement,"
    "{attributes:true,attributeFilter:['class']});"
    "})();";

@interface AlookThemeHandler : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) UIViewController *viewController;
@end

@implementation AlookThemeHandler

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.name isEqualToString:@"alookTheme"]) return;
    NSString *theme = message.body;
    BOOL isDark = [theme isEqualToString:@"dark"];
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *viewController = self.viewController;
        if (viewController == nil) return;
        objc_setAssociatedObject(
            viewController,
            kAlookWebDarkThemeKey,
            @(isDark),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC
        );
        alookApplyTheme(viewController, isDark);
    });
}

@end

@implementation UIViewController (AlookSafeArea)

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
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
    if (isTauriRoot) alookPrepareStartupOverlay(self);
    UIEdgeInsets insets = self.view.safeAreaInsets;
    WKWebView *startupWebView = nil;
    for (UIView *subview in self.view.subviews) {
        if ([subview isKindOfClass:[WKWebView class]]) {
            CGRect bounds = self.view.bounds;
            subview.frame = CGRectMake(
                insets.left,
                insets.top,
                bounds.size.width - insets.left - insets.right,
                bounds.size.height - insets.top - insets.bottom
            );

            WKWebView *webView = (WKWebView *)subview;
            startupWebView = webView;
            CGFloat splashOffsetY = (insets.bottom - insets.top) / 2.0;
            NSString *splashOffsetScript = [NSString stringWithFormat:
                @"document.documentElement.style.setProperty('--alook-mobile-splash-offset-y','%.3fpx')",
                splashOffsetY];
            [webView evaluateJavaScript:splashOffsetScript completionHandler:nil];
            static dispatch_once_t scriptToken;
            dispatch_once(&scriptToken, ^{
                AlookThemeHandler *handler = [[AlookThemeHandler alloc] init];
                handler.viewController = self;
                [webView.configuration.userContentController
                    addScriptMessageHandler:handler name:@"alookTheme"];
                WKUserScript *script = [[WKUserScript alloc]
                    initWithSource:kThemeObserverScript
                    injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
                    forMainFrameOnly:YES];
                [webView.configuration.userContentController addUserScript:script];
            });

            alookApplyTheme(self, alookEffectiveDarkTheme(self));
        }
    }
    if (startupWebView != nil) {
        UIView *overlay = isTauriRoot ? objc_getAssociatedObject(self, kAlookStartupOverlayKey)
                                     : alookInstallStartupOverlay(self);
        if (overlay != nil) alookLayoutStartupOverlay(self, overlay);
        if (![objc_getAssociatedObject(self, kAlookStartupProbeStartedKey) boolValue]) {
            objc_setAssociatedObject(
                self,
                kAlookStartupProbeStartedKey,
                @YES,
                OBJC_ASSOCIATION_RETAIN_NONATOMIC
            );
            alookWaitForWebViewSurface(self, startupWebView, 0);
        }
    }
}

@end

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}
