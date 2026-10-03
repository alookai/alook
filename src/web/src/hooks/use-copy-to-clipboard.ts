"use client";

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCallback, useRef, useEffect } from "react";

export function useCopyToClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useAtom(useCreateAtom(false));
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), resetDelay);
        return true;
      } catch {
        return false;
      }
    },
    [resetDelay, setCopied]
  );

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return { copy, copied };
}
