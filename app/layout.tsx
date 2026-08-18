import type { Metadata } from "next";
import "./globals.css";
import { ThemeToggle } from "@/app/ThemeToggle";
import { LOCAL_PROJECT_MARKER_KEY, PRINCIPLES_RETURN_PENDING_KEY, THEME_PREFERENCE_KEY } from "@/lib/site-path";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Bangumi Resorter",
  description: "用两两比较重新发现你真正偏爱的 Bangumi 条目。",
  applicationName: "Bangumi Resorter",
  referrer: "strict-origin-when-cross-origin",
  icons: {
    icon: `${basePath}/og.png`,
    shortcut: `${basePath}/og.png`,
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "Bangumi Resorter",
    description: "用两两比较，重新发现你真正偏爱的作品。",
    images: [{ url: `${basePath}/og.png`, width: 1730, height: 909, alt: "Bangumi Resorter" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bangumi Resorter",
    description: "用两两比较，重新发现你真正偏爱的作品。",
    images: [`${basePath}/og.png`],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{const k=${JSON.stringify(THEME_PREFERENCE_KEY)},v=localStorage.getItem(k),p=v==="light"||v==="dark"||v==="system"?v:"system",d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.themePreference=p;document.documentElement.dataset.theme=d?"dark":"light";if(sessionStorage.getItem(${JSON.stringify(PRINCIPLES_RETURN_PENDING_KEY)})==="1"||localStorage.getItem(${JSON.stringify(LOCAL_PROJECT_MARKER_KEY)})==="1")document.documentElement.dataset.resorterRestoring="true"}catch{}` }} />
        <meta name="color-scheme" content="light dark" />
        <link rel="preconnect" href="https://lain.bgm.tv" />
        <link rel="dns-prefetch" href="//lain.bgm.tv" />
      </head>
      <body>{children}<ThemeToggle /></body>
    </html>
  );
}
