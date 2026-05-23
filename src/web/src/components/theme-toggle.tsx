"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const toggle = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  if (!mounted) {
    return (
      <Button variant="ghost" size="sm" disabled>
        <Sun className="size-4" />
      </Button>
    );
  }

  const Icon = resolvedTheme === "dark" ? Moon : Sun;

  return (
    <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme">
      <Icon className="size-4" />
    </Button>
  );
}
