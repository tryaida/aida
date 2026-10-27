import { describe, expect, it } from "vitest";
import { assertLocalDatabase, assertWritesAllowed, isLocalBaseUrl } from "../../src/capture/write-guard.js";

describe("isLocalBaseUrl", () => {
  it("accepts 127.0.0.1 and localhost", () => {
    expect(isLocalBaseUrl("http://127.0.0.1:3100")).toBe(true);
    expect(isLocalBaseUrl("http://localhost:3000")).toBe(true);
  });

  it("rejects a public URL", () => {
    expect(isLocalBaseUrl("https://app.example.com")).toBe(false);
  });

  it("rejects hostnames that merely start with a local prefix (bug: regex prefix match)", () => {
    expect(isLocalBaseUrl("http://localhost.evil.com")).toBe(false);
    expect(isLocalBaseUrl("http://127.0.0.1.nip.io")).toBe(false);
  });

  it("rejects a userinfo trick that puts 'localhost' before the real (public) host", () => {
    expect(isLocalBaseUrl("http://localhost:1@prod.example.com")).toBe(false);
  });

  it("accepts [::1] and bracketed IPv6 localhost", () => {
    expect(isLocalBaseUrl("http://[::1]:3100")).toBe(true);
  });
});

describe("assertWritesAllowed", () => {
  it("allows writes against a local baseUrl with no config", () => {
    expect(() => assertWritesAllowed("http://127.0.0.1:3100", undefined)).not.toThrow();
  });

  it("refuses writes against a non-local baseUrl by default", () => {
    expect(() => assertWritesAllowed("https://app.example.com", undefined)).toThrow(/refusing/i);
  });

  it("allows writes against a non-local baseUrl when allowWrites is true", () => {
    expect(() => assertWritesAllowed("https://app.example.com", true)).not.toThrow();
  });
});

describe("assertLocalDatabase", () => {
  it("allows a 127.0.0.1 database URL", () => {
    expect(() => assertLocalDatabase("postgresql://demo@127.0.0.1:55432/app_demo")).not.toThrow();
  });

  it("refuses a non-local database URL", () => {
    expect(() => assertLocalDatabase("postgresql://user:pw@prod-db.example.com:5432/app")).toThrow(/refusing/i);
  });

  it("refuses a hostname that merely embeds 'localhost' in its path/query (bug: regex substring match)", () => {
    expect(() => assertLocalDatabase("postgres://prod.db.example.com:5432/app?x=localhost/")).toThrow(/refusing/i);
  });

  it("refuses a host/hostaddr query-param override even when the authority looks local", () => {
    expect(() => assertLocalDatabase("postgresql://127.0.0.1:5432/app?host=prod.example.com")).toThrow(/refusing/i);
    expect(() => assertLocalDatabase("postgresql://localhost:5432/app?hostaddr=10.0.0.5")).toThrow(/refusing/i);
  });

  it("allows a local database URL with unrelated query params", () => {
    expect(() => assertLocalDatabase("postgresql://127.0.0.1:5432/app?sslmode=require")).not.toThrow();
  });
});
