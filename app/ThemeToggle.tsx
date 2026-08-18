"use client";

import { useEffect, useState } from "react";
import { THEME_PREFERENCE_KEY } from "@/lib/site-path";

export type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const THEME_PREFERENCES: ThemePreference[] = ["system", "light", "dark"];
const THEME_LABELS: Record<ThemePreference, string> = {
  system: "系统",
  light: "浅色",
  dark: "深色",
};
const THEME_ICONS: Record<ThemePreference, string> = {
  system: "◐",
  light: "☀",
  dark: "☾",
};

function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readThemePreference() {
  try {
    const value = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system" as const;
  }
}

function resolveTheme(preference: ThemePreference, mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")): ResolvedTheme {
  return preference === "system" ? (mediaQuery.matches ? "dark" : "light") : preference;
}

function applyTheme(preference: ThemePreference, mediaQuery?: MediaQueryList) {
  const resolved = resolveTheme(preference, mediaQuery);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
}

function nextThemePreference(preference: ThemePreference) {
  const index = THEME_PREFERENCES.indexOf(preference);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length];
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const saved = readThemePreference();
      setPreference(saved);
      applyTheme(saved, mediaQuery);
    };
    const onMediaChange = () => {
      const current = document.documentElement.dataset.themePreference;
      if (isThemePreference(current) && current === "system") applyTheme(current, mediaQuery);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_PREFERENCE_KEY) sync();
    };

    sync();
    mediaQuery.addEventListener("change", onMediaChange);
    window.addEventListener("storage", onStorage);
    return () => {
      mediaQuery.removeEventListener("change", onMediaChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const next = nextThemePreference(preference);
  const label = THEME_LABELS[preference];
  const nextLabel = THEME_LABELS[next];
  return <button
    className="theme-toggle"
    type="button"
    aria-label={`当前主题：${label}，点击切换到${nextLabel}`}
    title={`主题：${label}（点击切换到${nextLabel}）`}
    onClick={() => {
      const nextPreference = nextThemePreference(preference);
      try { window.localStorage.setItem(THEME_PREFERENCE_KEY, nextPreference); } catch { /* Theme still works for this page. */ }
      setPreference(nextPreference);
      applyTheme(nextPreference);
    }}
  >
    <span className="theme-toggle-icon" aria-hidden="true">{THEME_ICONS[preference]}</span>
    <span>主题：{label}</span>
  </button>;
}
