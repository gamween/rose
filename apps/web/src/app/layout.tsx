import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, siteUrl } from "@/lib/site";
import { departureMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: SITE_TAGLINE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: "summary_large_image", title: SITE_TAGLINE, description: SITE_DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: "#070605",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn(GeistSans.variable, GeistMono.variable, departureMono.variable)}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
