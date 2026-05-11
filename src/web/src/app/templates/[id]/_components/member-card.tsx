import { Badge } from "@/components/ui/badge";

const ROLE_COLORS: Record<string, string> = {
  leader: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  researcher: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  engineer: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  assistant: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
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
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <Badge
        variant="outline"
        className={`text-[10px] font-medium ${ROLE_COLORS[role] || ""}`}
      >
        {roleLabel}
      </Badge>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
