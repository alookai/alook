"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";

export default function AgentsRedirect() {
  const router = useRouter();
  const { slug } = useWorkspace();

  useEffect(() => {
    router.replace(`/w/${slug}/home`);
  }, [router, slug]);

  return null;
}
