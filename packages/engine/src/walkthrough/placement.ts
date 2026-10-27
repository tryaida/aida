// Where a walkthrough's page sits in the help library (docs/scope.md "Help site": Getting
// started, How do I…, Screens and settings, Words we use, Troubleshooting and FAQ, What's new).
// A walkthrough's optional `section:` picks the spot: a first segment naming a top-level category
// (by title or slug, any case) puts it there; anything else is a feature group inside "How do I…".
// Segments nest with " / ", e.g. `section: Entries / Late entries`. Pure: no file access.

export interface LibraryCategory {
  slug: string;
  title: string;
  /** One plain sentence for the category's own index page. */
  description: string;
}

/** The top-level library categories, in site order. */
export const LIBRARY_CATEGORIES: readonly LibraryCategory[] = [
  { slug: "getting-started", title: "Getting started", description: "The first things to set up and learn." },
  { slug: "how-do-i", title: "How do I…", description: "Step-by-step guides for everyday tasks." },
  { slug: "screens-and-settings", title: "Screens and settings", description: "What each screen and setting is for." },
  { slug: "words-we-use", title: "Words we use", description: "What the words used in the app mean." },
  {
    slug: "troubleshooting-and-faq",
    title: "Troubleshooting and FAQ",
    description: "Fixes for common problems and answers to common questions.",
  },
  { slug: "whats-new", title: "What's new", description: "Recent changes to the app." },
];

export const DEFAULT_CATEGORY_SLUG = "how-do-i";

export interface LibraryPlacement {
  category: { slug: string; title: string };
  /** Feature groups below the category, outermost first. Empty for a page straight in a category. */
  groups: { slug: string; title: string }[];
  /** Page folder relative to `content/docs`, e.g. "how-do-i/payments/record-a-payment". */
  dir: string;
  /** Site URL, e.g. "/how-do-i/payments/record-a-payment". */
  url: string;
  /** Reader-facing path of the page's section, e.g. "How do I… / Payments". */
  displayPath: string;
}

/** A URL/folder slug for a section segment: lowercase ASCII letters and digits joined by hyphens
 * ("Late entries" -> "late-entries", "What's new" -> "whats-new", "How do I…" -> "how-do-i"). */
export function sectionSlug(segment: string): string {
  return segment
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Splits a `section:` value into trimmed segments ("Entries / Late entries" -> 2 segments). */
export function sectionSegments(section: string): string[] {
  return section.split("/").map((s) => s.trim());
}

// Plain words: letters, digits, spaces and light punctuation. No slashes inside a segment (they
// separate segments), no Markdown/MDX syntax, no path tricks.
const SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’&,.()?!…+-]*$/u;

/** Problems with a `section:` value, in plain words — empty when it's fine. Used by the
 * walkthrough schema, so a bad value fails at load time with a line number. */
export function sectionProblems(section: string): string[] {
  if (section.trim() === "") return ["section can't be empty — leave it out to use How do I…"];
  const problems: string[] = [];
  for (const segment of sectionSegments(section)) {
    if (segment === "") {
      problems.push('section has an empty part — separate parts with " / ", e.g. "Entries / Late entries"');
      continue;
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      problems.push(`section part "${segment}" should be plain words (letters, numbers, spaces)`);
      continue;
    }
    const slug = sectionSlug(segment);
    if (slug === "") problems.push(`section part "${segment}" needs at least one letter or number a web address can use`);
    else if (slug === "index") problems.push(`section part "${segment}" can't be called "index"`);
  }
  return problems;
}

function findCategory(segment: string): LibraryCategory | undefined {
  const slug = sectionSlug(segment);
  return LIBRARY_CATEGORIES.find((c) => c.slug === slug || c.title.toLowerCase() === segment.toLowerCase());
}

/**
 * Where walkthrough `id` sits in the library, from its optional `section:` value. Category rules
 * (docs/scope.md "Help site"): no section -> "How do I…"; a first segment naming a category (title
 * or slug, any case) -> that category, with any further segments as groups inside it; otherwise
 * every segment is a group inside "How do I…".
 */
export function libraryPlacement(section: string | undefined, id: string): LibraryPlacement {
  const segments = section && section.trim() !== "" ? sectionSegments(section).filter((s) => s !== "") : [];
  let category = LIBRARY_CATEGORIES.find((c) => c.slug === DEFAULT_CATEGORY_SLUG) as LibraryCategory;
  let groupSegments = segments;
  const named = segments.length > 0 ? findCategory(segments[0]) : undefined;
  if (named) {
    category = named;
    groupSegments = segments.slice(1);
  }
  const groups = groupSegments.map((title) => ({ slug: sectionSlug(title), title })).filter((g) => g.slug !== "");
  const dir = [category.slug, ...groups.map((g) => g.slug), id].join("/");
  return {
    category: { slug: category.slug, title: category.title },
    groups,
    dir,
    url: `/${dir}`,
    displayPath: [category.title, ...groups.map((g) => g.title)].join(" / "),
  };
}
