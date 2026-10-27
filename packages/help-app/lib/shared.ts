// Site-wide constants. Everything brand-specific (name, logo, colours) comes from lib/brand.ts.
export const siteRoute = "";

/** Top-level library categories (docs/scope.md "Help site"), in sidebar order. */
export const siteSections = [
  { slug: "getting-started", title: "Getting started" },
  { slug: "how-do-i", title: "How do I…" },
  { slug: "screens-and-settings", title: "Screens and settings" },
  { slug: "words-we-use", title: "Words we use" },
  { slug: "troubleshooting-and-faq", title: "Troubleshooting and FAQ" },
  { slug: "whats-new", title: "What's new" },
] as const;
