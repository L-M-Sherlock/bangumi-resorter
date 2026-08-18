"use client";

import { MouseEvent, ReactNode, useEffect } from "react";
import {
  PRINCIPLES_RETURN_PENDING_KEY,
  PRINCIPLES_RETURN_TARGET_KEY,
  sitePath,
} from "@/lib/site-path";

function normalizedPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function appUrl(value: string, fallback: string) {
  try {
    const candidate = new URL(value, window.location.href);
    const root = new URL(fallback, window.location.origin);
    return candidate.origin === window.location.origin
      && normalizedPath(candidate.pathname) === normalizedPath(root.pathname);
  } catch {
    return false;
  }
}

function unmodifiedLeftClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function AppReturnLink({ className, children }: { className?: string; children: ReactNode }) {
  const href = sitePath("/");

  useEffect(() => {
    if (!appUrl(document.referrer, href)) return;
    try {
      window.sessionStorage.setItem(PRINCIPLES_RETURN_TARGET_KEY, document.referrer);
    } catch {
      // The link still works as an ordinary navigation when storage is unavailable.
    }
  }, [href]);

  function returnToApp(event: MouseEvent<HTMLAnchorElement>) {
    if (!unmodifiedLeftClick(event)) return;
    let target = document.referrer;
    try {
      target = window.sessionStorage.getItem(PRINCIPLES_RETURN_TARGET_KEY) ?? target;
    } catch {
      // Fall back to the current document referrer.
    }
    if (!appUrl(target, href)) return;

    try {
      window.sessionStorage.setItem(PRINCIPLES_RETURN_PENDING_KEY, "1");
    } catch {
      // History restoration remains useful without the loading-state fallback.
    }
    if (window.history.length <= 1) return;

    event.preventDefault();
    const principlesPath = normalizedPath(new URL(sitePath("/principles"), window.location.origin).pathname);
    let fallbackTimer = 0;
    const stop = () => {
      window.removeEventListener("popstate", continueBack);
      window.clearTimeout(fallbackTimer);
    };
    const continueBack = () => {
      if (normalizedPath(window.location.pathname) !== principlesPath) {
        stop();
        return;
      }
      window.requestAnimationFrame(() => window.history.back());
    };
    window.addEventListener("popstate", continueBack);
    fallbackTimer = window.setTimeout(() => {
      stop();
      window.location.assign(href);
    }, 1200);
    window.history.back();
  }

  return <a className={className} href={href} onClick={returnToApp}>{children}</a>;
}
