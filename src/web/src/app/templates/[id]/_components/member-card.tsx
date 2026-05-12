const ROLE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  leader: {
    bg: "bg-amber-50 dark:bg-amber-950/30",
    text: "text-amber-700 dark:text-amber-300",
    label: "Leader",
  },
  researcher: {
    bg: "bg-sky-50 dark:bg-sky-950/30",
    text: "text-sky-700 dark:text-sky-300",
    label: "Researcher",
  },
  engineer: {
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    text: "text-emerald-700 dark:text-emerald-300",
    label: "Engineer",
  },
  assistant: {
    bg: "bg-violet-50 dark:bg-violet-950/30",
    text: "text-violet-700 dark:text-violet-300",
    label: "Assistant",
  },
};

const FALLBACK_STYLE = {
  bg: "bg-muted/40",
  text: "text-muted-foreground",
  label: "Agent",
};

export function MemberCard({
  role,
  roleLabel,
  description,
}: {
  role: string;
  roleLabel: string;
  description: string;
}) {
  const style = ROLE_STYLES[role] || FALLBACK_STYLE;

  return (
    <div className={`rounded-lg p-4 ${style.bg}`}>
      <span className={`text-xs font-semibold uppercase tracking-wider ${style.text}`}>
        {roleLabel}
      </span>
      <p className="mt-2 text-sm leading-relaxed text-foreground/80">
        {description}
      </p>
    </div>
  );
}
