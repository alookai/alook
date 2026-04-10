import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { AgentProvider } from "@/contexts/agent-context";
import { AppSidebar } from "@/components/app-sidebar";
import { GradientBackground } from "@/components/gradient-background";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/sign-in");

  return (
    <AgentProvider>
      <div className="flex h-screen overflow-hidden relative">
        <GradientBackground />

        {/* Sidebar rail — stable across route changes */}
        <AppSidebar />

        {/* Floating content panel */}
        <div className="flex-1 min-w-0 p-2 pl-0">
          <main className="h-full rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
      </div>
    </AgentProvider>
  );
}
