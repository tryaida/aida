// Writes a recording out as a draft walkthrough file: the same YAML shape a person or aida-write
// writes, with a banner saying it's a draft and comments on anything to check. The file is
// checked against the walkthrough schema before it's returned, like `aida import playwright`.
import * as YAML from "yaml";
import type { Persona } from "../walkthrough/index.js";
import { WalkthroughDocSchema } from "../walkthrough/schema.js";
import type { DraftSteps } from "./steps.js";

export interface DraftMeta {
  id: string;
  title: string;
  startPage: string;
  /** Who the recording signed in as; written as `signed_in_as` when it's only a role. */
  persona?: Persona;
  needs?: string[];
  section?: string;
  /** The day recorded, `YYYY-MM-DD`. */
  recordedOn: string;
}

export function draftYaml(meta: DraftMeta, built: DraftSteps): string {
  const persona = meta.persona;
  const start: Record<string, unknown> = {};
  if (persona) {
    const onlyRole = persona.role && Object.keys(persona).every((k) => k === "role");
    if (onlyRole) start.signed_in_as = persona.role;
    else start.persona = persona;
  }
  start.page = meta.startPage;

  const raw: Record<string, unknown> = {
    walkthrough: meta.id,
    title: meta.title,
    summary: "TODO: one or two sentences on what this walkthrough helps the reader do.",
    ...(meta.section ? { section: meta.section } : {}),
    start,
    ...(meta.needs && meta.needs.length > 0 ? { needs: meta.needs } : {}),
    ...(Object.keys(built.data).length > 0 ? { data: built.data } : {}),
    steps: built.steps.map((s) => ({ id: s.id, title: s.title, say: s.say, actions: s.actions })),
  };

  const doc = new YAML.Document();
  doc.contents = doc.createNode(raw);
  const noted = built.steps.filter((s) => s.noted).length;
  doc.commentBefore = [
    ` DRAFT — recorded with \`aida record\` on ${meta.recordedOn}.`,
    " Before publishing: write the summary and `for:`, rewrite each step's title and `say:`",
    noted > 0
      ? `  (${noted} of ${built.steps.length} use your own notes; the rest are placeholders), and`
      : "  (placeholders from what was clicked), and",
    " check each TODO below. `aida capture` replays it; the aida-write skill can polish it.",
  ].join("\n");

  const stepsNode = doc.get("steps", true) as YAML.YAMLSeq;
  built.steps.forEach((s, i) => {
    if (s.comments.length === 0) return;
    const node = stepsNode.items[i] as YAML.YAMLMap;
    node.commentBefore = s.comments.map((c) => ` ${c}`).join("\n");
  });
  if (built.trailing.length > 0) doc.comment = built.trailing.map((c) => ` ${c}`).join("\n");

  const text = doc.toString();
  WalkthroughDocSchema.parse(YAML.parse(text));
  return text;
}
