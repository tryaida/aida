// Which device's screenshots and video a reader sees (decision 40). Guides captured on a phone
// as well as a computer offer both; the reader's choice is shared by every switch on the site and
// remembered, and until they choose, a phone-sized screen gets the phone version.
"use client";

import { useCallback, useEffect, useState } from "react";

export type Device = "desktop" | "phone";

export const DEVICE_LABELS: Record<Device, string> = { desktop: "Computer", phone: "Phone" };

const STORAGE_KEY = "aida-device";
const CHANGE_EVENT = "aida-device-change";
/** Below this width the reader is taken to be on a phone (Tailwind's `sm` breakpoint). */
export const PHONE_QUERY = "(max-width: 639px)";

/** The stored choice, if it's one of the devices on offer; else what the reader's screen suggests. */
export function pickDevice(stored: string | null, available: readonly Device[], screenIsPhone: boolean): Device {
  if (stored && (available as readonly string[]).includes(stored)) return stored as Device;
  const suggested: Device = screenIsPhone ? "phone" : "desktop";
  return available.includes(suggested) ? suggested : available[0];
}

/** This page's own choice, kept in memory: with storage blocked (private mode, an embed), every
 * switch re-reads on CHANGE_EVENT and would otherwise find nothing stored and snap back to the
 * screen suggestion. Checked before storage; another tab's choice (the "storage" event) replaces it. */
let chosen: string | null = null;

type ChoiceStorage = () => Pick<Storage, "getItem" | "setItem">;

/** The reader's choice: this page's in-memory one first, else what storage holds (null when
 * nothing is stored or storage is blocked). */
export function readChoice(storage: ChoiceStorage): string | null {
  if (chosen) return chosen;
  try {
    return storage().getItem(STORAGE_KEY);
  } catch {
    // Storage blocked: fall back to the screen size.
    return null;
  }
}

/** Remembers `next` for this page, and in storage when it's allowed. */
export function writeChoice(next: string | null, storage?: ChoiceStorage): void {
  chosen = next;
  if (!storage || next === null) return;
  try {
    storage().setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered across pages, but this page still switches.
  }
}

/**
 * The device to show, from those `available` (primary first), and a setter that every other
 * switch on the page follows. Renders the primary device first (server and first paint agree),
 * then moves to the stored or screen-suggested one.
 */
export function useDevice(available: readonly Device[]): [Device, (device: Device) => void] {
  const key = available.join(",");
  const [device, setDevice] = useState<Device>(available[0]);

  useEffect(() => {
    const read = () => {
      const stored = readChoice(() => window.localStorage);
      setDevice(pickDevice(stored, available, window.matchMedia(PHONE_QUERY).matches));
    };
    const fromOtherTab = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      writeChoice(event.newValue);
      read();
    };
    read();
    window.addEventListener(CHANGE_EVENT, read);
    window.addEventListener("storage", fromOtherTab);
    return () => {
      window.removeEventListener(CHANGE_EVENT, read);
      window.removeEventListener("storage", fromOtherTab);
    };
    // `key` stands for `available`, which callers usually pass as a fresh array literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const choose = useCallback((next: Device) => {
    writeChoice(next, () => window.localStorage);
    setDevice(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [device, choose];
}
