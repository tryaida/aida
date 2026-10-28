// `aida domain` in a workspace monorepo: the schema lives in a shared package, split across a
// `models/` subfolder, not in the app's own folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAppDomain, workspaceRoot } from "../../src/commands/domain.js";
import { buildDomain } from "../../src/domain/index.js";

let root: string;

function write(rel: string, text: string): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aida-domain-ws-"));
  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  write("package.json", "{}");
  write("apps/web/package.json", "{}");
  write("packages/db/prisma/schema.prisma", 'datasource db {\n  provider = "postgresql"\n}\n');
  write(
    "packages/db/prisma/models/event.prisma",
    "model Event {\n  id    String @id\n  title String\n  rsvps Rsvp[]\n  @@map(\"events\")\n}\n",
  );
  write(
    "packages/db/prisma/models/rsvp.prisma",
    "model Rsvp {\n  id      String @id\n  eventId String @map(\"event_id\")\n  event   Event  @relation(fields: [eventId], references: [id])\n  @@map(\"rsvps\")\n}\n",
  );
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("domain in a workspace monorepo", () => {
  it("reads a multi-file Prisma schema whose models sit in a subfolder", () => {
    const result = buildDomain(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.source.kind).toBe("prisma");
    expect(result.model.entities.map((e) => e.name).sort()).toEqual(["Event", "Rsvp"]);
  });

  it("finds the workspace root above an app folder", () => {
    expect(workspaceRoot(path.join(root, "apps/web"))).toBe(root);
  });

  it("falls back to the workspace when the app folder has no schema", () => {
    const app = path.join(root, "apps/web");
    expect(buildDomain(app).ok).toBe(false);
    const result = buildAppDomain(app);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.source.kind).toBe("prisma");
  });

  it("doesn't fall back when the repo was named explicitly", () => {
    expect(buildAppDomain(path.join(root, "apps/web"), {}, false).ok).toBe(false);
  });
});
