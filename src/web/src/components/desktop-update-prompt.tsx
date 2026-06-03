"use client";

import { useEffect, useState } from "react";
import { isTauri, isDesktop, tauriInvoke } from "@alook/shared";
import { toast } from "sonner";

export function DesktopUpdatePrompt() {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (checked || !isTauri() || !isDesktop()) return;
    setChecked(true);

    tauriInvoke<{ available: boolean; version: string | null; notes: string | null }>("check_for_updates")
      .then((info) => {
        if (info.available && info.version) {
          toast(`Update available: v${info.version}`, {
            duration: Infinity,
            action: {
              label: "Update now",
              onClick: () => {
                tauriInvoke("install_update").catch(() => {
                  toast.error("Update failed — try again later");
                });
              },
            },
          });
        }
      })
      .catch(() => {});
  }, [checked]);

  return null;
}
