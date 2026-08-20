"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "@/lib/auth-client";
import { clearAllCache } from "@/lib/chat-cache";
import { clearPersistedQueryCache } from "@/platform/client";
import { useCommunityStore } from "@/stores/community";
import { useCommunityWsStore } from "@/stores/community/ws";
import { useMessageStreamStore } from "@/stores/community/message-stream";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { LogOut } from "lucide-react";
import { displayName } from "@/lib/community/display-name";
import { ProfileAvatar } from "@/components/avatar";

export function NavUser() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const user = session?.user;
  if (!mounted || isPending || !user)
    return <Skeleton className="size-10 rounded-xl" />;

  const userDisplayName = displayName(user);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={user.name}
            aria-label={`Open user menu for ${userDisplayName}`}
            data-testid="nav-user-trigger"
            className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
          />
        }
      >
        <ProfileAvatar
          label={userDisplayName}
          seed={user.id}
          src={user.image}
          size={28}
          alt=""
          data-testid="nav-user-trigger-avatar"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-52 rounded-lg"
        side="right"
        align="end"
        sideOffset={8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-2 py-2 text-left text-sm">
              <ProfileAvatar
                label={userDisplayName}
                seed={user.id}
                src={user.image}
                size={28}
                data-testid="nav-user-menu-avatar"
              />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {userDisplayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={async () => {
              // Clear community-local state (timers, subscription) so no
              // WS handler timers survive past sign-out.
              useCommunityStore.getState().reset();
              useCommunityWsStore.getState().reset();
              useMessageStreamStore.getState().resetAll();
              await clearAllCache();
              // Drop the persisted IDB blob so the next user on this machine
              // doesn't inherit the previous session's cached message rows.
              await clearPersistedQueryCache(user.id).catch(() => {});
              await signOut();
              router.push("/sign-in");
            }}
          >
            <LogOut className="size-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
