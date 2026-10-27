"use client";
// The proof sheet (decision 35, checkpoint 1): the latest `aida proof` — a help site page, a
// printed page, the quick reference card and two video frames side by side — so the look is
// approved once. Read-only: the sheet comes from <buildDir>/proof via /studio/api/proof.
import { useEffect, useState } from "react";
import { getJson, useStudioBlob } from "./api";
import { aidaCli } from "./aida-cli";
import { Icon, Spinner } from "./icons";

interface ProofJson {
  walkthrough: string;
  style: string;
  generatedAt: string;
  panels: { id: string; label: string; note?: string }[];
}

export function ProofPanel({ open, onClose, studioToken }: { open: boolean; onClose: () => void; studioToken: string }) {
  const [info, setInfo] = useState<{ status: "loading" } | { status: "ready"; proof: ProofJson } | { status: "missing" }>({ status: "loading" });
  const image = useStudioBlob(open && info.status === "ready" ? `/studio/api/proof?kind=png&t=${encodeURIComponent(info.proof.generatedAt)}` : undefined, studioToken);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInfo({ status: "loading" });
    getJson<ProofJson>("/studio/api/proof?kind=json", studioToken).then(
      (proof) => !cancelled && setInfo({ status: "ready", proof }),
      () => !cancelled && setInfo({ status: "missing" }),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, studioToken, onClose]);

  if (!open) return null;
  const notes = info.status === "ready" ? info.proof.panels.filter((p) => p.note) : [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-label="Proof sheet" onClick={onClose}>
      <div className="studio-surface flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-fd-border shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-fd-border px-5 py-3">
          <Icon name="sparkles" className="size-4 text-fd-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Proof sheet</h2>
            <p className="text-[12px] text-fd-muted-foreground">
              {info.status === "ready"
                ? `${info.proof.walkthrough} · style ${info.proof.style} · made ${new Date(info.proof.generatedAt).toLocaleString()}`
                : "How the brand looks on the help site, printed guides and videos, side by side."}
            </p>
          </div>
          <button type="button" className="studio-btn h-8 px-2" onClick={onClose} aria-label="Close">
            <Icon name="x" className="size-4" />
          </button>
        </div>
        <div className="studio-scroll min-h-0 flex-1 overflow-auto bg-fd-muted/40 p-5">
          {info.status === "loading" || (info.status === "ready" && image.status === "loading") ? (
            <div className="flex h-64 items-center justify-center text-fd-muted-foreground">
              <Spinner />
            </div>
          ) : info.status === "ready" && image.status === "ready" ? (
            // eslint-disable-next-line @next/next/no-img-element -- token-guarded blob URL
            <img src={image.src} alt="Proof sheet: video frames, help site page, printed page and card" className="mx-auto w-full rounded-lg shadow" />
          ) : (
            <div className="mx-auto max-w-lg py-16 text-center text-sm text-fd-muted-foreground">
              <p className="font-medium text-fd-foreground">No proof sheet yet.</p>
              <p className="mt-2">Make one after a build, then reopen this:</p>
              <pre className="mt-3 rounded-md bg-fd-muted px-3 py-2 text-left text-[12px]">{aidaCli("proof")}</pre>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-fd-border px-5 py-3 text-[12px] text-fd-muted-foreground">
          <span className="min-w-0 flex-1">
            {notes.length > 0 ? notes.map((n) => `${n.label}: ${n.note}`).join(" · ") : "Change the look in aida.config's brand (or brand.md), then run it again:"}
          </span>
          <code className="shrink-0 rounded bg-fd-muted px-2 py-1">{aidaCli("proof")}</code>
        </div>
      </div>
    </div>
  );
}
