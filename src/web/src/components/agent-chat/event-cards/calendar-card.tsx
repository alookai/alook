import React from "react";

const REPEAT_LABELS: Record<string, string> = {
  "1day": "Daily",
  "1week": "Weekly",
  "1month": "Monthly",
};

function humanizeRepeat(interval: string): string {
  if (REPEAT_LABELS[interval]) return REPEAT_LABELS[interval];
  const m = /^(\d+)(hour|day|week|month)s?$/.exec(interval);
  if (m) return `Every ${m[1]} ${m[2]}${Number(m[1]) > 1 ? "s" : ""}`;
  return interval;
}

export function CalendarCard({
  title,
  scheduledAt,
  repeatInterval,
  onClick,
}: {
  title: string;
  scheduledAt?: string;
  repeatInterval?: string;
  onClick?: () => void;
}) {
  const date = scheduledAt ? new Date(scheduledAt) : null;
  const dayOfWeek = date
    ? date.toLocaleDateString("en-US", { weekday: "short" })
    : null;
  const monthStr = date
    ? date.toLocaleDateString("en-US", { month: "short" })
    : null;
  const dayNum = date ? date.getDate() : null;
  const timeStr = date
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="card-grain w-104 max-w-full overflow-hidden rounded-(--radius) border border-(--border) text-left cursor-pointer [transition:translate_.2s_cubic-bezier(.2,.8,.2,1),box-shadow_.2s_ease] hover:-translate-y-0.5 [box-shadow:var(--e1)] hover:[box-shadow:var(--e2)]"
    >
      <span className="h-6 bg-(--tc) flex items-center px-3">
        {date ? (
          <span className="text-[0.62rem] font-semibold uppercase tracking-[0.06em] text-white/85">
            {dayOfWeek} {monthStr} {dayNum}
          </span>
        ) : (
          <span className="text-[0.62rem] font-semibold uppercase tracking-[0.06em] text-white/85">
            Calendar
          </span>
        )}
        {repeatInterval && (
          <span className="ml-auto text-[0.52rem] font-semibold uppercase tracking-[0.04em] px-1 py-px rounded-full bg-white/20 text-white/90">
            {humanizeRepeat(repeatInterval)}
          </span>
        )}
      </span>
      <span className="bg-(--paper) p-3 flex gap-3 items-start">
        {dayNum != null && (
          <span className="text-[1.8rem] font-bold leading-none tracking-[-0.02em] opacity-80 min-w-8 text-center shrink-0">
            {dayNum}
          </span>
        )}
        <span className="min-w-0 flex-1 flex flex-col">
          <span className="text-[0.92rem] font-semibold tracking-[-0.01em] leading-[1.3]">
            {title}
          </span>
          {timeStr && (
            <span className="text-[0.72rem] text-(--muted-foreground) mt-1 font-mono">
              {timeStr}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
