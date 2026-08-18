import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
