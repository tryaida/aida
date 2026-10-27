import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { libraryTree } from "@/lib/tree";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { VersionSwitcher } from "@/components/version-switcher";
import { siteTitle } from "@/lib/brand";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
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
  );
}
