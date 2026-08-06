import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Rooms for people and agents.",
  robots: { index: false, follow: true },
  openGraph: {
    images: [{ url: "/og?title=Sign In", width: 1200, height: 630 }],
  },
};

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  // Already signed in → community home. `/workspaces` was the retired legacy
  // (v0) surface.
  if (session) redirect("/c/me");

  return <>{children}</>;
}
