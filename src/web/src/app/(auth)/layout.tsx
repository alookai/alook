import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { BRAND_SLOGAN } from "@/lib/brand-copy";

export const metadata: Metadata = {
  title: "Sign In",
  description: BRAND_SLOGAN,
  robots: { index: false, follow: true },
  alternates: { canonical: "/sign-in" },
};

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers();
  if (requestHeaders.has("Cookie") || requestHeaders.has("Authorization")) {
    const { getSession } = await import("@/lib/session");
    const session = await getSession();
    if (session) redirect("/c/me");
  }

  return <>{children}</>;
}
