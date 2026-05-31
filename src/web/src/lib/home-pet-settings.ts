"use client";

import { useEffect, useState } from "react";

const HOME_PET_SETTINGS_CHANGED_EVENT = "alook-home-pet-settings-changed";
const HOME_PET_ENABLED_STORAGE_KEY = "alook-home-pet-enabled-v1";

export type HomePetSettings = {
  enabled: boolean;
};

const DEFAULT_HOME_PET_SETTINGS: HomePetSettings = {
  enabled: false,
};

export function readHomePetSettings(): HomePetSettings {
  if (typeof window === "undefined") {
    return DEFAULT_HOME_PET_SETTINGS;
  }

  const enabled = window.localStorage.getItem(HOME_PET_ENABLED_STORAGE_KEY);

  return {
    enabled: enabled === null ? DEFAULT_HOME_PET_SETTINGS.enabled : enabled === "true",
  };
}

export function writeHomePetSettings(settings: Partial<HomePetSettings>) {
  const next = {
    ...readHomePetSettings(),
    ...settings,
  };

  window.localStorage.setItem(HOME_PET_ENABLED_STORAGE_KEY, String(next.enabled));
  window.dispatchEvent(
    new CustomEvent<HomePetSettings>(HOME_PET_SETTINGS_CHANGED_EVENT, {
      detail: next,
    })
  );

  return next;
}

export function useHomePetSettings() {
  const [settings, setSettings] = useState<HomePetSettings>(
    DEFAULT_HOME_PET_SETTINGS
  );

  useEffect(() => {
    setSettings(readHomePetSettings());

    const handleSettingsChanged = (event: Event) => {
      setSettings(
        (event as CustomEvent<HomePetSettings>).detail ?? readHomePetSettings()
      );
    };
    const handleStorageChanged = (event: StorageEvent) => {
      if (event.key === HOME_PET_ENABLED_STORAGE_KEY) {
        setSettings(readHomePetSettings());
      }
    };

    window.addEventListener(HOME_PET_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    window.addEventListener("storage", handleStorageChanged);

    return () => {
      window.removeEventListener(
        HOME_PET_SETTINGS_CHANGED_EVENT,
        handleSettingsChanged
      );
      window.removeEventListener("storage", handleStorageChanged);
    };
  }, []);

  return settings;
}
