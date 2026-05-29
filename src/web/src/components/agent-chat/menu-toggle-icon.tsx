import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function MenuToggleIcon({ open }: { open: boolean }) {
  return (
    <span className="relative size-4">
      <Menu
        className={cn(
          "size-4 absolute transition-all duration-200",
          open
            ? "opacity-0 rotate-90 scale-75"
            : "opacity-100 rotate-0 scale-100",
        )}
      />
      <X
        className={cn(
          "size-4 absolute transition-all duration-200",
          open
            ? "opacity-100 rotate-0 scale-100"
            : "opacity-0 -rotate-90 scale-75",
        )}
      />
    </span>
  );
}
