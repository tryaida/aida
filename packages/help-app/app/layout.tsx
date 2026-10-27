import type { Metadata } from "next";
import { Providers } from "@/components/site/providers";
import { brand, siteTitle } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: siteTitle, template: `%s · ${siteTitle}` },
  description: `Guides, videos and printable instructions for ${brand.name === "Help" ? "this app" : brand.name}.`,
  icons: brand.icon ? { icon: brand.icon, apple: brand.icon } : undefined,
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The app's own font (lib/brand.json, from aida.config's brand). A plain stylesheet
         * link rather than next/font: the family is only known per app, and hosts then don't
         * need network access to Google Fonts at build time. */}
        {brand.fontUrl ? (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
            <link rel="stylesheet" href={brand.fontUrl} />
          </>
        ) : null}
      </head>
      <body className="flex min-h-screen flex-col">
        {/* Search: Ctrl/⌘ K and Fumadocs' search buttons open aida's dialog over the
         * engine-built public/search-index.json (no server route, works on a static export). */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
