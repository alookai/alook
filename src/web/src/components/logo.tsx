"use client";

import { useTheme } from "next-themes";
import Image from "next/image";
import { cn } from "@/lib/utils";

const sizes = {
  sm: { icon: 28, text: "text-2xl" },
  lg: { icon: 36, text: "text-4xl" },
} as const;

export function Logo({
  size = "sm",
  className,
  iconOnly = false,
}: {
  size?: "sm" | "lg";
  className?: string;
  iconOnly?: boolean;
}) {
  const { icon, text } = sizes[size];
  const { resolvedTheme, setTheme } = useTheme();

  const toggle = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      className={cn(
        "flex items-center gap-2 cursor-pointer select-none transition-opacity hover:opacity-70",
        className
      )}
    >
      <Image
        src="/alook.svg"
        alt="Alook"
        width={icon}
        height={icon}
      />
      {!iconOnly && (
        <span
          className={cn(text, "font-black tracking-tight")}
          style={{ fontFamily: "var(--font-brand)" }}
        >
          Alook
        </span>
      )}
    </button>
  );
}
