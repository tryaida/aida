import { afterEach, describe, expect, it } from "vitest";
import { pickDevice, readChoice, writeChoice } from "../../lib/device";

describe("pickDevice", () => {
  it("uses the stored choice when it's one of the devices on offer", () => {
    expect(pickDevice("phone", ["desktop", "phone"], false)).toBe("phone");
    expect(pickDevice("desktop", ["desktop", "phone"], true)).toBe("desktop");
  });

  it("ignores a stored choice that isn't on offer (a page without that device)", () => {
    expect(pickDevice("phone", ["desktop"], false)).toBe("desktop");
  });

  it("with nothing stored, suggests phone on a phone-sized screen when phone is on offer", () => {
    expect(pickDevice(null, ["desktop", "phone"], true)).toBe("phone");
  });

  it("with nothing stored, suggests desktop on a wider screen", () => {
    expect(pickDevice(null, ["desktop", "phone"], false)).toBe("desktop");
  });

  it("falls back to the first available device when the suggestion isn't on offer", () => {
    expect(pickDevice(null, ["phone"], false)).toBe("phone");
    expect(pickDevice(null, ["desktop"], true)).toBe("desktop");
  });
});

describe("readChoice / writeChoice", () => {
  const blocked = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  const memoryStorage = () => {
    const items = new Map<string, string>();
    return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
  };
  afterEach(() => writeChoice(null));

  it("keeps the choice in memory when storage is blocked, so every switch re-reads it", () => {
    expect(readChoice(blocked)).toBeNull();
    writeChoice("phone", blocked);
    expect(readChoice(blocked)).toBe("phone");
    expect(pickDevice(readChoice(blocked), ["desktop", "phone"], false)).toBe("phone");
  });

  it("stores the choice when storage works", () => {
    const store = memoryStorage();
    writeChoice("phone", () => store);
    expect(store.getItem("aida-device")).toBe("phone");
    writeChoice(null);
    expect(readChoice(() => store)).toBe("phone");
  });

  it("another tab's choice replaces the in-memory one", () => {
    writeChoice("phone", blocked);
    writeChoice("desktop");
    expect(readChoice(blocked)).toBe("desktop");
  });
});
