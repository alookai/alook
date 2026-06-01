"use client";

import { cn } from "@/lib/utils";

/**
 * Social presence line above the composer. Reads the agent the way you'd read a
 * colleague in an IM thread — never the raw task lifecycle, never counts.
 *
 *   generating (this conversation's task is running) → "{Name} is typing…" + dots
 *   busy        (queued here, or the agent is on other work) → "{Name}'s on something, she'll see this"
 *   idle        → nothing
 *
 * Copy is verbatim from Priya. No em dashes. Crossfades on change and gates the
 * typing-dot animation behind prefers-reduced-motion.
 */

type Presence = "typing" | "busy" | "idle";

function derivePresence(
  taskStatus: string | null | undefined,
  agentBusyElsewhere: boolean,
): Presence {
  if (taskStatus === "running") return "typing";
  if (taskStatus === "queued" || taskStatus === "dispatched") return "busy";
  if (agentBusyElsewhere) return "busy";
  return "idle";
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.2s_infinite]" />
      <span className="size-1 rounded-full bg-muted-foreground/60 motion-safe:animate-[typing-dot_1.2s_ease-in-out_0.4s_infinite]" />
    </span>
  );
}

export function PresenceLine({
  agentFirstName,
  taskStatus,
  agentBusyElsewhere = false,
}: {
  agentFirstName: string;
  taskStatus: string | null | undefined;
  agentBusyElsewhere?: boolean;
}) {
  const presence = derivePresence(taskStatus, agentBusyElsewhere);

  // Reserve a fixed-height row so the composer never shifts as presence changes.
  // mb gives the line breathing room above the composer (it sat too close).
  return (
    <div className="h-5 px-1 mb-2 flex items-center" aria-live="polite">
      <span
        key={presence}
        className={cn(
          "inline-flex items-center gap-1.5 text-sm text-muted-foreground",
          presence !== "idle" && "motion-safe:animate-[fade-up_200ms_ease-out_both]",
        )}
      >
        {presence === "typing" && (
          <>
            <span>{agentFirstName} is typing</span>
            <TypingDots />
          </>
        )}
        {presence === "busy" && (
          <span>{agentFirstName}&apos;s on something, she&apos;ll see this</span>
        )}
      </span>
    </div>
  );
}
