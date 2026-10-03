"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, useCallback, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScrollToBottomButtonProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  threshold?: number;
}

export function ScrollToBottomButton({ scrollRef, threshold = 100 }: ScrollToBottomButtonProps) {
  const [showButton, setShowButton] = useAtom(useCreateAtom(false));

  const check = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    const hasOverflow = el.scrollHeight > el.clientHeight;
    setShowButton(hasOverflow && !atBottom);
  }, [scrollRef, setShowButton, threshold]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    el.addEventListener("scroll", check, { passive: true });
    check();

    const ro = new ResizeObserver(check);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [scrollRef, check]);

  const handleClick = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div
      className={cn(
        "absolute bottom-1 left-1/2 -translate-x-1/2 z-10 transition-all duration-200 ease-out",
        showButton
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-2 pointer-events-none"
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleClick}
              className="rounded-full bg-background/80 backdrop-blur-sm border shadow-sm hover:bg-background"
            />
          }
        >
          <ArrowDown />
        </TooltipTrigger>
        <TooltipContent side="top">Scroll to bottom</TooltipContent>
      </Tooltip>
    </div>
  );
}
