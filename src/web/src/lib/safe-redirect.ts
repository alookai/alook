import {
  isSafeRedirectPath as sharedIsSafeRedirectPath,
  safeRedirectPath as sharedSafeRedirectPath,
} from "@alook/shared";
import { isRetiredWorkspacePath } from "./retired-workspace";

export const isSafeRedirectPath = sharedIsSafeRedirectPath;
export function safeRedirectPath(input: string | null | undefined, fallback = "/c/me"): string {
  const path = sharedSafeRedirectPath(input, fallback);
  return isRetiredWorkspacePath(new URL(path, "https://alook.ai").pathname) ? "/c/me" : path;
}
