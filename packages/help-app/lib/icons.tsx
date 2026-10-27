// Icons for the library's fixed top-level categories (docs/scope.md "Help site"), and for the
// sections the engine creates inside "How do I…": those get an icon matched from their title,
// so each topic card on the home page reads differently instead of repeating the category's.
import {
  Archive,
  ArrowUpDown,
  Bell,
  BookOpen,
  Bookmark,
  Boxes,
  Building2,
  CalendarDays,
  ChartColumn,
  CircleHelp,
  ClipboardList,
  Clock,
  Compass,
  CreditCard,
  FileText,
  Image,
  Layers,
  LayoutPanelTop,
  ListChecks,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Plug,
  Printer,
  Puzzle,
  Receipt,
  Rocket,
  Settings,
  Shapes,
  ShoppingCart,
  Sparkles,
  Star,
  Tag,
  Trophy,
  Truck,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

const CATEGORY_ICONS: Record<string, ReactNode> = {
  "getting-started": <Rocket />,
  "how-do-i": <ListChecks />,
  "screens-and-settings": <LayoutPanelTop />,
  "words-we-use": <BookOpen />,
  "troubleshooting-and-faq": <CircleHelp />,
  "whats-new": <Sparkles />,
};

/** Icon for a top-level category folder (`$ref.folder` is its path under content/docs). */
export function categoryIcon(folderPath: string | undefined): ReactNode | undefined {
  return folderPath ? CATEGORY_ICONS[folderPath] : undefined;
}

// Common words in a section's title or folder name, matched as word starts, first match wins.
const SECTION_KEYWORDS: [RegExp, ComponentType][] = [
  [/\b(pay|billing|card|refund|subscription|checkout)/, CreditCard],
  [/\b(invoice|billing|receipt|fee|price|pricing|charge)/, Receipt],
  [/\b(user|people|person|member|contact|customer|client|competitor|player|team|staff|guest|attendee|student)/, Users],
  [/\b(account|setting|preference|profile|config)/, Settings],
  [/\b(report|analytic|stat|chart|dashboard|insight|metric)/, ChartColumn],
  [/\b(event|calendar|schedule|booking|appointment|session|round|fixture)/, CalendarDays],
  [/\b(result|score|ranking|leaderboard|award|prize|winner)/, Trophy],
  [/\b(entr|registration|sign.?up|form|application|enrol)/, ClipboardList],
  [/\b(email|mail|invite|newsletter)/, Mail],
  [/\b(message|chat|comment|conversation)/, MessageSquare],
  [/\b(notification|alert|reminder)/, Bell],
  [/\b(document|file|note|page|content)/, FileText],
  [/\b(product|inventory|stock|item|catalog)/, Package],
  [/\b(order|cart|shop|store|purchase)/, ShoppingCart],
  [/\b(shipping|delivery|dispatch)/, Truck],
  [/\b(security|password|login|sign.?in|permission|access|role)/, Lock],
  [/\b(import|export|sync|upload|download|backup)/, ArrowUpDown],
  [/\b(integration|connect|api|webhook|plugin)/, Plug],
  [/\b(print|label|badge|certificate)/, Printer],
  [/\b(organi[sz]ation|compan|venue|club|school|business|workspace)/, Building2],
  [/\b(location|address|map|site)/, MapPin],
  [/\b(photo|image|media|gallery)/, Image],
  [/\b(time|hour|timesheet|history)/, Clock],
  [/\b(categor|tag|group|division|class)/, Tag],
  [/\b(archive)/, Archive],
];

// Used in order when a title matches nothing (or only icons a sibling already took).
const FALLBACK_ICONS: ComponentType[] = [Layers, Boxes, Compass, Puzzle, Bookmark, Shapes, Star];

/**
 * Icons for sibling sections, one per section, no two alike while icons last: the first
 * keyword match not already taken by an earlier sibling, else the next unused fallback.
 */
export function sectionIcons(sections: { title: string; slug?: string }[]): ReactNode[] {
  const used = new Set<ComponentType>();
  return sections.map(({ title, slug }) => {
    const text = `${title} ${slug?.replace(/-/g, " ") ?? ""}`.toLowerCase();
    const Icon =
      SECTION_KEYWORDS.find(([pattern, icon]) => !used.has(icon) && pattern.test(text))?.[1] ??
      FALLBACK_ICONS.find((icon) => !used.has(icon)) ??
      FALLBACK_ICONS[used.size % FALLBACK_ICONS.length];
    used.add(Icon);
    return <Icon />;
  });
}
