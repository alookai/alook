"use client";

import { createContext, useContext, type ReactNode, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ChannelBar } from "@/components/channel-bar";
import { GradientBackground } from "@/components/gradient-background";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { RuntimeVersionGate } from "@/components/runtime-version-gate";

const SidebarTriggerContext = createContext<(() => void) | null>(null);

export function useSidebarTrigger() {
  return useContext(SidebarTriggerContext);
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (isMobile) {
    return (
      <SidebarTriggerContext.Provider value={() => setSidebarOpen(true)}>
        <div className="flex flex-col h-dvh overflow-hidden relative">
          <GradientBackground />
          <div className="flex-1 min-h-0 px-2 pb-2 pt-2 flex flex-col">
            <ChannelBar isMobile />
            <main className="flex-1 min-h-0 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
              {children}
            </main>
          </div>
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" showCloseButton={false} style={{ width: 56 }} className="p-0">
              <AppSidebar onNavigate={() => setSidebarOpen(false)} />
            </SheetContent>
          </Sheet>
          <RuntimeVersionGate />
        </div>
      </SidebarTriggerContext.Provider>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden relative">
      <GradientBackground />
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0 pt-1 pr-2 pb-2">
        <ChannelBar />
        <main className="flex-1 min-h-0 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
          {children}
        </main>
      </div>
      <RuntimeVersionGate />
    </div>
  );
}
