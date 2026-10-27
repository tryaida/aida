// POST /studio/api/edit — the Studio's "Save" calls land here, then straight into the engine's
// shared edit actions (docs/scope.md: "Studio buttons, the agent, the CLI... all use the same
// small set of actions"). Edits made through the Studio are always `by: "person"`.
import { NextResponse } from "next/server";
import {
  addBlur,
  addCallout,
  EditLockedError,
  EditValidationError,
  removeBlur,
  removeCallout,
  removeStep,
  reorderCallouts,
  reorderSteps,
  setPageBlock,
  setStepField,
  updateBlur,
  updateCallout,
  type OverlayPatch,
  type StepField,
} from "aida-docs/dist/edit/index.js";
import type { BlurBox, Callout } from "aida-docs/dist/walkthrough/index.js";
import { devOnlyGuard } from "../../_lib/dev-only";
import { assertSlug, pagesDir, pageFileFor, resolveWalkthroughFile } from "../../_lib/server";
import { assertStudioRequest } from "../../_lib/security";

interface EditBody {
  action:
    | "setStepField"
    | "reorderSteps"
    | "removeStep"
    | "setPageBlock"
    | "addCallout"
    | "updateCallout"
    | "removeCallout"
    | "reorderCallouts"
    | "addBlur"
    | "updateBlur"
    | "removeBlur";
  walkthroughId?: string;
  stepId?: string;
  field?: StepField;
  value?: string | number;
  newOrder?: string[];
  key?: string;
  text?: string;
  callout?: Callout;
  blur?: BlurBox;
  itemId?: string;
  patch?: OverlayPatch;
}

export async function POST(request: Request) {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const security = assertStudioRequest(request);
  if (security) return security;

  let body: EditBody;
  try {
    body = (await request.json()) as EditBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = dispatch(body);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof EditLockedError ? 423 : err instanceof EditValidationError ? 422 : 400;
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status });
  }
}

function dispatch(body: EditBody) {
  switch (body.action) {
    case "setStepField": {
      if (!body.walkthroughId || !body.stepId || !body.field || body.value === undefined) {
        throw new Error("setStepField requires walkthroughId, stepId, field and value");
      }
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return setStepField(file, body.stepId, body.field, body.value, { by: "person" });
    }
    case "reorderSteps": {
      if (!body.walkthroughId || !body.newOrder) throw new Error("reorderSteps requires walkthroughId and newOrder");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return reorderSteps(file, body.newOrder, { by: "person" });
    }
    case "removeStep": {
      if (!body.walkthroughId || !body.stepId) throw new Error("removeStep requires walkthroughId and stepId");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return removeStep(file, body.stepId, { by: "person" });
    }
    case "setPageBlock": {
      // The file to write is never taken from the request — only a walkthrough id, resolved
      // server-side to the one page file aida built for it (see pageFileFor). This is what
      // stops a cross-site request from naming an arbitrary file (e.g. app/api/chat/route.ts).
      if (!body.walkthroughId || !body.key || body.text === undefined) {
        throw new Error("setPageBlock requires walkthroughId, key and text");
      }
      assertSlug(body.walkthroughId);
      const file = pageFileFor(body.walkthroughId);
      if (!file) throw new Error(`no built page for walkthrough "${body.walkthroughId}"`);
      return setPageBlock(file, body.key, body.text, { by: "person", pagesDir: pagesDir() });
    }
    case "addCallout": {
      if (!body.walkthroughId || !body.stepId || !body.callout) throw new Error("addCallout requires walkthroughId, stepId and callout");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return addCallout(file, body.stepId, body.callout, { by: "person" });
    }
    case "updateCallout": {
      if (!body.walkthroughId || !body.stepId || !body.itemId || !body.patch) {
        throw new Error("updateCallout requires walkthroughId, stepId, itemId and patch");
      }
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return updateCallout(file, body.stepId, body.itemId, body.patch, { by: "person" });
    }
    case "removeCallout": {
      if (!body.walkthroughId || !body.stepId || !body.itemId) throw new Error("removeCallout requires walkthroughId, stepId and itemId");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return removeCallout(file, body.stepId, body.itemId, { by: "person" });
    }
    case "reorderCallouts": {
      if (!body.walkthroughId || !body.stepId || !body.newOrder) throw new Error("reorderCallouts requires walkthroughId, stepId and newOrder");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return reorderCallouts(file, body.stepId, body.newOrder, { by: "person" });
    }
    case "addBlur": {
      if (!body.walkthroughId || !body.stepId || !body.blur) throw new Error("addBlur requires walkthroughId, stepId and blur");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return addBlur(file, body.stepId, body.blur, { by: "person" });
    }
    case "updateBlur": {
      if (!body.walkthroughId || !body.stepId || !body.itemId || !body.patch) {
        throw new Error("updateBlur requires walkthroughId, stepId, itemId and patch");
      }
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return updateBlur(file, body.stepId, body.itemId, body.patch, { by: "person" });
    }
    case "removeBlur": {
      if (!body.walkthroughId || !body.stepId || !body.itemId) throw new Error("removeBlur requires walkthroughId, stepId and itemId");
      assertSlug(body.walkthroughId);
      const file = resolveWalkthroughFile(body.walkthroughId);
      return removeBlur(file, body.stepId, body.itemId, { by: "person" });
    }
    default:
      throw new Error(`unknown action "${(body as { action?: string }).action}"`);
  }
}
