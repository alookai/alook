import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ headers: vi.fn(), getSession: vi.fn(), redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
import AuthLayout, { metadata } from "./layout";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.headers.mockResolvedValue(new Headers());
  mocks.getSession.mockResolvedValue(null);
});
describe("(auth) layout", () => {
  it("gives sign-in its own noindex metadata", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toEqual({ canonical: "/sign-in" });
  });
  it("renders anonymous children without initializing auth", async () => {
    const result = await AuthLayout({ children: "sign in form" });
    expect(result.props.children).toBe("sign in form");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it.each(["Cookie", "Authorization"])("validates %s before redirecting a signed-in visitor", async name => {
    mocks.headers.mockResolvedValue(new Headers({ [name]: "fixture" }));
    mocks.getSession.mockResolvedValue({ user: { id: "viewer" } });
    await AuthLayout({ children: "form" });
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/c/me");
  });
  it("keeps the sign-in form for an invalid cookie", async () => {
    mocks.headers.mockResolvedValue(new Headers({ Cookie: "expired=fixture" }));
    const result = await AuthLayout({ children: "form" });
    expect(result.props.children).toBe("form");
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
