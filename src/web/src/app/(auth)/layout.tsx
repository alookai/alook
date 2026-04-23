import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to manage your always-on AI agents on Alook.",
  openGraph: {
    images: [{ url: "/api/og?title=Sign In", width: 1200, height: 630 }],
  },
};

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (session) redirect("/workspaces?auto");

  return <>{children}</>;
}
