// Client-side providers for the whole app: Fumadocs' theme/search context with aida's own
// search dialog (components/site/search-dialog.tsx) plugged in. A client file because the dialog
// is passed as a component, which can't cross the server/client boundary as a prop.
"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import HelpSearchDialog from "./search-dialog";

export function Providers({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog: HelpSearchDialog }}>{children}</RootProvider>;
}
