import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { libraryTree } from "@/lib/tree";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { VersionSwitcher } from "@/components/version-switcher";
import { SkipToContent } from "@/components/site/skip-link";
import { siteTitle } from "@/lib/brand";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <>
      {/* WCAG 2.2 AA 2.4.1 — first in tab order, ahead of DocsLayout's own nav/sidebar.
       * This (not the root layout) is where every page with Fumadocs' `#nd-page` article
       * actually renders — see components/site/skip-link.tsx. */}
      <SkipToContent />
      <DocsLayout
        tree={libraryTree()}
        {...baseOptions()}
        sidebar={{
          // Version switcher (build-plan.md M21): renders nothing until a version has been frozen.
          banner: <VersionSwitcher />,
        }}
      >
        {children}
        {/* scope.md "Help chat": "On the site and as a drop-in widget inside the app" — this is
         * the site's own copy; public/widget.js is the drop-in for the user's app. If the owner
         * hasn't set ANTHROPIC_API_KEY, /api/chat answers 503 and the widget shows that message
         * inline — the rest of the site is unaffected either way. */}
        <ChatWidget title={siteTitle} />
      </DocsLayout>
    </>
  );
}
