import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { HomePage } from "@/components/home/home-page";
import { WorkspaceRedirect } from "@/components/workspace-redirect";

export const metadata: Metadata = {
  title: "Alook — Always-on AI Agents",
  description:
    "Your AI agents, always on. Give them an email, let them work for you around the clock.",
  alternates: { canonical: "https://alook.ai" },
};

export default async function Page() {
  const session = await getSession();
  if (session) return <WorkspaceRedirect />;
  return <HomePage isLoggedIn={false} />;
}
