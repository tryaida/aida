import Link from "next/link";
import { BrandMark } from "@/components/site/brand-mark";
import { SearchTrigger } from "@/components/site/search-trigger";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-24 text-center">
      <BrandMark />
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">We couldn&apos;t find that page</h1>
        <p className="text-fd-muted-foreground">It may have moved when the guides were reorganised. Try searching instead.</p>
      </div>
      <SearchTrigger />
      <Link href="/" className="text-sm font-medium text-fd-primary hover:underline">
        Go to the help centre home
      </Link>
    </main>
  );
}
