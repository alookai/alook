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
static const void *kAlookStartupCompletedKey = &kAlookStartupCompletedKey;
static const NSInteger kAlookStartupLogoTag = 8738;
static const NSInteger kAlookStartupErrorTag = 8739;
static UIView *gAlookStartupOverlay = nil;
static BOOL gAlookStartupCompleted = NO;
static BOOL gAlookStartupFailed = NO;

static BOOL alookIsTauriRootController(UIViewController *viewController) {
    Class taoViewController = NSClassFromString(@"TaoUIViewController");
    return taoViewController != Nil && [viewController isKindOfClass:taoViewController];
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
    viewController.view.backgroundColor = isDark ? alookDarkColor() : alookLightColor();
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
    if (isTauriRoot) alookPrepareStartupOverlay(self);
    UIEdgeInsets insets = self.view.safeAreaInsets;
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

}

@end

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}
