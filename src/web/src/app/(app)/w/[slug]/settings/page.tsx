"use client";

import { useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GeneralTab } from "./general-tab";
import { InstructionTab } from "./instruction-tab";
import { MembersTab } from "./members-tab";
import { NotificationTab } from "./notification-tab";
import { PetTab } from "./pet-tab";
import { UsagesTab } from "./usages-tab";

const TABS = [
  { id: "general", label: "General" },
  { id: "pet", label: "Pet" },
  { id: "instruction", label: "Global Instruction" },
  { id: "notifications", label: "Notifications" },
  { id: "members", label: "Members" },
  { id: "usages", label: "Usages" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("general");

  return (
    <>
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Settings</h1>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <nav className="w-48 shrink-0 border-r border-border/50 py-3 px-2 hidden sm:flex sm:flex-col">
          <div className="flex-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "w-full rounded-md px-2 py-2 text-left text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <div className="px-2 pt-3 border-t border-border/50 text-[11px] text-muted-foreground/60">
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
          )}
        </nav>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-4 pt-2 sm:hidden">
            <Tabs className="items-center" value={activeTab} onValueChange={(v) => setActiveTab(v as TabId)}>
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
            activeTab !== "instruction" && "px-4 py-4"
          )}>
            {activeTab === "instruction" ? (
              <InstructionTab />
            ) : activeTab === "usages" ? (
              <UsagesTab />
            ) : (
              <div className="mx-auto max-w-md">
                {activeTab === "general" && <GeneralTab />}
                {activeTab === "pet" && <PetTab />}
                {activeTab === "notifications" && <NotificationTab />}
                {activeTab === "members" && <MembersTab />}
              </div>
            )}
          </div>
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <div className="px-4 py-2 text-[11px] text-muted-foreground/60 sm:hidden">
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
