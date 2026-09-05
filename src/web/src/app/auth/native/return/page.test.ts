import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NativeOauthReturnPage from "./page";

const ATTEMPT = "attempt_1234567890123456";
const CODE = "c".repeat(32);

describe("native OAuth return fallback", () => {
  it("offers an app link without rendering the handoff code as text", async () => {
    const page = await NativeOauthReturnPage({
      searchParams: Promise.resolve({ attempt: ATTEMPT, code: CODE }),
    });
    const html = renderToStaticMarkup(page);
    const visibleText = html.replace(/<[^>]+>/g, "");

    expect(html).toContain(
      `href="ai.alook://auth/native/return?attempt=${ATTEMPT}&amp;code=${CODE}"`,
    );
    expect(visibleText).toContain("Open Alook");
    expect(visibleText).not.toContain(CODE);
  });

  it("renders no launch control for malformed input", async () => {
    const page = await NativeOauthReturnPage({
      searchParams: Promise.resolve({ attempt: "bad", code: CODE }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("href=");
    expect(html).toContain("invalid or has expired");
  });

  it("returns a sanitized failure result to the app", async () => {
    const page = await NativeOauthReturnPage({
      searchParams: Promise.resolve({
        attempt: ATTEMPT,
        status: "access_denied",
      }),
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain(
      `href="ai.alook://auth/native/return?attempt=${ATTEMPT}&amp;status=access_denied"`,
    );
  });

  it("rejects ambiguous code and status results", async () => {
    const page = await NativeOauthReturnPage({
      searchParams: Promise.resolve({
        attempt: ATTEMPT,
        code: CODE,
        status: "access_denied",
      }),
    });
    expect(renderToStaticMarkup(page)).not.toContain("href=");
  });
});
