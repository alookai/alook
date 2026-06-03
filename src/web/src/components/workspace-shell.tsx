"use client";

import { createContext, useContext, type ReactNode, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { GradientBackground } from "@/components/gradient-background";
import { WorkspacePetLayer } from "@/components/home-pet/workspace-pet-layer";
import { RuntimeVersionGate } from "@/components/runtime-version-gate";
import { useWorkspace } from "@/contexts/workspace-context";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { AgentChatSheetProvider } from "@/contexts/agent-chat-sheet-context";
const SidebarTriggerContext = createContext<(() => void) | null>(null);

export function useSidebarTrigger() {
  return useContext(SidebarTriggerContext);
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const { slug } = useWorkspace();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  if (isMobile) {
    return (
      <SidebarTriggerContext.Provider value={() => setSidebarOpen(true)}>
        <AgentChatSheetProvider>
          <div ref={shellRef} className="flex flex-col h-dvh overflow-hidden relative">
            <GradientBackground />
            <div className="flex-1 min-h-0 px-2 pb-2 pt-2 flex flex-col">
              <MobileTopBar />
              <main className="flex-1 min-h-0 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
                {children}
              </main>
            </div>
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetContent side="left" showCloseButton={false} style={{ width: 56 }} className="p-0">
                <AppSidebar onNavigate={() => setSidebarOpen(false)} />
              </SheetContent>
            </Sheet>
            <WorkspacePetLayer boundaryRef={shellRef} slug={slug} />
            <RuntimeVersionGate />
          </div>
        </AgentChatSheetProvider>
      </SidebarTriggerContext.Provider>
    );
  }

  return (
    <AgentChatSheetProvider>
      <div ref={shellRef} className="flex h-dvh overflow-hidden relative">
        <GradientBackground />
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0 pt-2 pr-2 pb-2">
          <main className="flex-1 min-h-0 rounded-xl bg-card/80 backdrop-blur-xl shadow-lg ring-1 ring-border/40 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
        <WorkspacePetLayer boundaryRef={shellRef} slug={slug} />
        <RuntimeVersionGate />
      </div>
    </AgentChatSheetProvider>
  );
}
