"use client";

import { useState } from "react";
import { MobileSidebarLogo } from "@/components/mobile-sidebar-logo";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GeneralTab } from "./general-tab";
import { InstructionTab } from "./instruction-tab";
import { MembersTab } from "./members-tab";

const TABS = [
  { id: "general", label: "General" },
  { id: "instruction", label: "Instruction" },
  { id: "members", label: "Members" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("general");

  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <MobileSidebarLogo />
          <h1 className="text-sm font-medium">Settings</h1>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <nav className="w-48 shrink-0 border-r border-border/50 py-3 px-2 hidden md:block">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                activeTab === tab.id
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 pt-2 md:hidden">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
              <TabsList className="h-auto gap-1">
                {TABS.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className={cn(
            "flex-1 overflow-y-auto thin-scrollbar",
            activeTab !== "instruction" && "px-5 py-5"
          )}>
            {activeTab === "instruction" ? (
              <InstructionTab />
            ) : (
              <div className="mx-auto max-w-md">
                {activeTab === "general" && <GeneralTab />}
                {activeTab === "members" && <MembersTab />}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
