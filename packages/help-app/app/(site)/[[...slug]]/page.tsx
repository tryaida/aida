// Renders one help page from content/docs (written by the aida engine's index stage). Three
// kinds of page (frontmatter `kind`): the home page, a library section (its topics and guides as
// cards), and a guide built from a walkthrough. Pages with `passed: false` are kept out of
// production builds — a walkthrough that hasn't verified clean against the real app shouldn't
// ship — but still render in dev so the Studio/editors can see what's wrong.
import { source } from "@/lib/source";
import { findFolder, guidesUnder, libraryTree } from "@/lib/tree";
import Link from "next/link";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { Clock, ListOrdered, PlayCircle, UserRound } from "lucide-react";
import { getMDXComponents } from "@/components/mdx";
import { LastCheckedBadge } from "@/components/last-checked-badge";
import { VideoEmbed } from "@/components/video-embed";
import { PageActions } from "@/components/site/page-actions";
import { HomeLibrary, SectionLibrary } from "@/components/site/library";
import { SearchTrigger } from "@/components/site/search-trigger";
import { BrandLogo } from "@/components/site/brand-mark";
import { plural } from "@/components/site/format";
import { brand } from "@/lib/brand";

type LoadedPage = NonNullable<ReturnType<typeof source.getPage>>;

/** Guides used to live at `/<walkthrough-id>`; send old links (and old in-app widgets) to the
 * page's place in the library. */
function legacyGuide(slug: string[] | undefined): LoadedPage | undefined {
  if (!slug || slug.length !== 1) return undefined;
  return source.getPages().find((p) => p.data.walkthrough === slug[0] && p.slugs.length > 1);
}

function Home({ page }: { page: LoadedPage }) {
  const MDX = page.data.body;
  const tree = libraryTree();
  const popular = guidesUnder(tree).slice(0, 5);
  // The engine writes a short generated body; its description already says the same, so only a
  // person's own words (no `generated` flag) are shown under the hero.
  const showBody = !page.data.placeholder && !page.data.generated;
  return (
    <DocsPage full toc={[]} breadcrumb={{ enabled: false }} footer={{ enabled: false }}>
      <section className="aida-hero not-prose relative mb-10 overflow-hidden rounded-[calc(var(--brand-radius)+8px)] border border-fd-border px-6 py-10 sm:px-10 sm:py-14">
        <div className="relative grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col items-start gap-5">
            <div className="flex items-center gap-3 text-sm font-medium text-fd-primary">
              <BrandLogo className="size-9" />
              <span>{brand.name === "Help" ? "Help centre" : `${brand.name} help centre`}</span>
            </div>
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-fd-foreground sm:text-5xl">
              How can we help?
            </h1>
            {page.data.description ? (
              <p className="max-w-2xl text-lg text-fd-muted-foreground">{page.data.description}</p>
            ) : null}
            <SearchTrigger />
          </div>
          {popular.length > 0 ? (
            <div className="hidden rounded-[calc(var(--brand-radius)+4px)] border border-fd-border bg-fd-background/70 p-4 backdrop-blur lg:block">
              <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-fd-muted-foreground">
                Popular guides
              </p>
              <ul className="flex flex-col">
                {popular.map(({ item, data }) => (
                  <li key={item.url}>
                    <Link
                      href={item.url}
                      className="group flex items-center gap-3 rounded-[var(--brand-radius)] px-2 py-2 text-sm hover:bg-fd-accent"
                    >
                      <PlayCircle className="size-4 shrink-0 text-fd-primary" />
                      <span className="flex-1 truncate font-medium group-hover:text-fd-primary">{item.name}</span>
                      {data.steps ? <span className="text-xs text-fd-muted-foreground">{data.steps}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>
      {showBody ? (
        <DocsBody className="mb-10">
          <MDX components={getMDXComponents()} />
        </DocsBody>
      ) : null}
      <HomeLibrary tree={tree} />
    </DocsPage>
  );
}

function Section({ page }: { page: LoadedPage }) {
  const MDX = page.data.body;
  const folder = findFolder(libraryTree(), page.url);
  return (
    <DocsPage full toc={[]}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description ? <DocsDescription>{page.data.description}</DocsDescription> : null}
      {page.data.placeholder || page.data.generated ? null : (
        <DocsBody>
          <MDX components={getMDXComponents()} />
        </DocsBody>
      )}
      {folder ? <SectionLibrary folder={folder} /> : null}
    </DocsPage>
  );
}

function Guide({ page }: { page: LoadedPage }) {
  const MDX = page.data.body;
  const d = page.data;
  return (
    // The engine's page repeats the title as an h1 (hidden by globals.css); keep it out of the TOC.
    <DocsPage toc={d.toc.filter((t) => t.depth > 1)} full={d.full} tableOfContent={{ style: "clerk" }}>
      <header className="not-prose flex flex-col gap-4 border-b border-fd-border pb-6">
        <DocsTitle className="font-heading">{d.title}</DocsTitle>
        {d.description ? <DocsDescription className="mb-0">{d.description}</DocsDescription> : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fd-muted-foreground">
          <LastCheckedBadge lastChecked={d.lastChecked} passed={d.passed ?? false} />
          {d.steps ? (
            <span className="inline-flex items-center gap-1.5">
              <ListOrdered className="size-4" /> {plural(d.steps, "step")}
            </span>
          ) : null}
          {d.for ? (
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="size-4" /> For {d.for.charAt(0).toLowerCase() + d.for.slice(1)}
            </span>
          ) : null}
          {d.video ? (
            <a href="#video" className="inline-flex items-center gap-1.5 hover:text-fd-primary print:hidden">
              <Clock className="size-4" /> Watch the video
            </a>
          ) : null}
        </div>
        <PageActions pdf={d.pdf} pdfCard={d.pdfCard} />
      </header>
      {d.video ? (
        <VideoEmbed src={d.video} vtt={d.vtt} srt={d.srt} poster={d.poster} chapters={d.chapters} title={d.title} />
      ) : null}
      <DocsBody className="aida-guide">
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

function Plain({ page }: { page: LoadedPage }) {
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description ? <DocsDescription>{page.data.description}</DocsDescription> : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export default async function Page(props: PageProps<"/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) {
    const moved = legacyGuide(params.slug);
    if (moved) permanentRedirect(moved.url);
    notFound();
  }

  // Build-time filter (scope.md "Last checked" badge / pages half): a page
  // the last capture marked failed never reaches a production build.
  if (process.env.NODE_ENV === "production" && page.data.passed === false) {
    notFound();
  }
  // A template placeholder section with no pages yet is hidden from the library (lib/tree.ts);
  // don't publish its "nothing here" page either.
  if (
    process.env.NODE_ENV === "production" &&
    page.data.placeholder &&
    page.slugs.length > 0 &&
    !findFolder(libraryTree(), page.url)
  ) {
    notFound();
  }

  const kind = page.data.kind ?? (page.data.walkthrough ? "walkthrough" : undefined);
  if (kind === "home" || page.slugs.length === 0) return <Home page={page} />;
  if (kind === "section") return <Section page={page} />;
  if (kind === "walkthrough") return <Guide page={page} />;
  return <Plain page={page} />;
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/[[...slug]]">): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug) ?? legacyGuide(params.slug);
  if (!page) notFound();

  return {
    // The home page uses the site title itself (app/layout.tsx's default).
    title: page.slugs.length === 0 ? undefined : page.data.title,
    description: page.data.description,
  };
}
