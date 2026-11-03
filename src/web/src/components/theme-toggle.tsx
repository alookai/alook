"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The one light/dark switch: an icon key (public pages, landing hero and nav). */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useAtom(useCreateAtom(false));

  useEffect(() => { setMounted(true); }, [setMounted]);

  const toggle = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className={className} disabled aria-label="Toggle theme">
        <Sun className="size-4" />
      </Button>
    );
  }

  const Icon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <Button variant="ghost" size="icon" className={className} onClick={toggle} aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={resolvedTheme === "dark" ? "Light theme" : "Dark theme"}>
      <Icon className="size-4" />
    </Button>
  );
}
