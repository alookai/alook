export const NATIVE_OAUTH_RETURN_HOST = "auth.alook.ai";
export const NATIVE_OAUTH_RETURN_PATH = "/auth/native/return";
export const NATIVE_OAUTH_ASSOCIATION_PATHS = [
  "/.well-known/apple-app-site-association",
  "/.well-known/assetlinks.json",
] as const;

export const nativeOauthSecurityHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
