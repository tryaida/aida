// The site's header mark: the app's own logo and name, then "Help". Light/dark logos swap with
// the theme when the app has both (lib/brand.json, written by the aida engine).
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";

export function BrandLogo({ className }: { className?: string }) {
  if (!brand.logo) return null;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand file, any size/format */}
      <img src={brand.logo} alt="" className={cn("object-contain", brand.logoDark && "dark:hidden", className)} />
      {brand.logoDark ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoDark} alt="" className={cn("hidden object-contain dark:block", className)} />
      ) : null}
    </>
  );
}

export function BrandMark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <BrandLogo className="size-7" />
      <span className="font-heading text-[0.95rem] font-semibold tracking-tight">
        {brand.name === "Help" ? "Help" : brand.name}
      </span>
      {brand.name === "Help" ? null : (
        <span className="rounded-full border border-fd-primary/25 bg-fd-primary/10 px-2 py-0.5 text-[0.7rem] font-medium uppercase tracking-wider text-fd-primary">
          Help
        </span>
      )}
    </span>
  );
}
