"use client";

import { cn } from "@/lib/utils";

/**
 * Social presence line above the composer. Three states:
 *   queued / dispatched → "{Name} is reading" + dots  (preparing / querying)
 *   running             → "{Name} is typing"  + dots  (actively generating)
 *   otherwise           → nothing (idle)
 *
 * The reading→typing distinction lets the user tell whether the agent is stuck
 * in query (e.g. runtime offline) vs actively working. Crossfades between
 * states and gates the dot animation behind prefers-reduced-motion.
 */

type Presence = "reading" | "typing" | "idle";

function derivePresence(taskStatus: string | null | undefined): Presence {
  if (taskStatus === "running") return "typing";
  if (taskStatus === "queued" || taskStatus === "dispatched") return "reading";
  return "idle";
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.2s_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.4s_infinite]" />
    </span>
  );
}

function presenceLabel(presence: Presence, name: string): string {
  if (presence === "reading") return `${name} is reading`;
  return `${name} is typing`;
}

export function PresenceLine({
  agentFirstName,
  taskStatus,
}: {
  agentFirstName: string;
  taskStatus: string | null | undefined;
}) {
  const presence = derivePresence(taskStatus);

  return (
    <div className="h-5 px-1 mb-2 flex items-center" aria-live="polite">
      <span
        key={presence}
        className={cn(
          "inline-flex items-center gap-2 text-sm text-muted-foreground",
          presence !== "idle" && "motion-safe:animate-[fade-up_200ms_ease-out_both]",
        )}
      >
        {presence !== "idle" && (
          <>
            <span>{presenceLabel(presence, agentFirstName)}</span>
            <TypingDots />
          </>
        )}
      </span>
    </div>
  );
}
