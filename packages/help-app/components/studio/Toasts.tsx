"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

export interface Toast {
  id: number;
  kind: "error" | "success" | "info";
  title: string;
  message?: string;
}

/** A tiny toast stack for the Studio: errors stay until dismissed (or 9 s), others leave after 4 s. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = next.current++;
    // The same message twice in a row (e.g. a dead server answering every call) shows once.
    setToasts((list) => (list.some((x) => x.title === t.title && x.message === t.message) ? list : [...list.slice(-3), { ...t, id }]));
    return id;
  }, []);
  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), toast.kind === "error" ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className="studio-toast-in pointer-events-auto flex items-start gap-3 rounded-xl border border-fd-border bg-fd-popover p-3 text-sm text-fd-popover-foreground shadow-lg"
    >
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          toast.kind === "error" && "bg-red-500/15 text-red-600 dark:text-red-400",
          toast.kind === "success" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
          toast.kind === "info" && "bg-fd-primary/15 text-fd-primary",
        )}
      >
        <Icon name={toast.kind === "error" ? "alert" : toast.kind === "success" ? "check" : "info"} className="size-3" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug">{toast.title}</p>
        {toast.message ? <p className="mt-0.5 break-words text-xs leading-relaxed text-fd-muted-foreground">{toast.message}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        className="studio-focus -mr-1 -mt-1 rounded-md p-1 text-fd-muted-foreground hover:bg-fd-muted hover:text-fd-foreground"
      >
        <Icon name="x" className="size-3.5" />
      </button>
    </div>
  );
}
