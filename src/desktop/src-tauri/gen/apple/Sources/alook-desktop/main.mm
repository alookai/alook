#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Constrain WKWebView frame to safe area so viewport height matches visible area
@implementation UIViewController (AlookSafeArea)

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        Method original = class_getInstanceMethod(self, @selector(viewDidLayoutSubviews));
        Method swizzled = class_getInstanceMethod(self, @selector(alook_viewDidLayoutSubviews));
        method_exchangeImplementations(original, swizzled);
    });
}

- (void)alook_viewDidLayoutSubviews {
    [self alook_viewDidLayoutSubviews];
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
            // Set background color matching theme
            BOOL isDark = (self.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark);
            self.view.backgroundColor = isDark
                ? [UIColor colorWithRed:0.133 green:0.125 blue:0.118 alpha:1.0]
                : [UIColor colorWithRed:0.929 green:0.910 blue:0.871 alpha:1.0];
        }
    }
}

@end

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}
