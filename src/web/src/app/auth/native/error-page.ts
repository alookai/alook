import {
  AUTH_STATUS_PAGE_CSP,
  renderAuthStatusPage,
} from "../../../../auth";
import { nativeOauthHtml } from "@/lib/native-oauth";

export function nativeOauthErrorPage(status: number): Response {
  return nativeOauthHtml(renderAuthStatusPage("unavailable"), {
    status,
    headers: {
      "Content-Security-Policy": AUTH_STATUS_PAGE_CSP,
    },
  });
}
