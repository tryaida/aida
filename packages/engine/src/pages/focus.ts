// Print figures (decision 36, build-plan.md M32): which frame each step's screenshot shows,
// which boxes on it are the step's real target, whether it's a screen the reader hasn't seen yet
// in this guide, and the focus crop around that target. Pure functions over the capture
// manifest — pages/build.ts renders the images, pdf/html.ts lays them out.
import type { Box, CaptureManifest, ManifestStep, Point } from "../capture/types.js";
import type { Walkthrough } from "../walkthrough/index.js";

/** Focus-crop geometry, in the frame's CSS px (viewport units, not device pixels). */
export const FOCUS_CROP = {
  /** Space between a target and its ring (matches annotate.ts's highlight padding). */
  pad: 8,
  /** Narrowest crop: enough UI around the target to orient (about 40% of a 1440px viewport). */
  minWidth: 560,
  /** Context kept either side of / above and below the target. */
  contextX: 140,
  contextY: 100,
  /** Preferred width:height, and the range a crop is held to. */
  aspect: 1.6,
  minAspect: 1.3,
  maxAspect: 2.4,
  /** A crop wider or taller than this share of the viewport isn't worth it: show the full screen. */
  maxShare: 0.72,
  /** Box a bare click point stands for: a field around the pointer, which usually runs on to
   * the right of where it was clicked (labels and typed text read left to right). */
  pointBox: { left: 120, right: 300, h: 40 },
} as const;

export interface StepFigurePlan {
  /** 1-based step number. */
  step: number;
  /** Frame file (under `<captureDir>/frames/`) this step's screenshot shows. */
  frame: string;
  /** Highlight boxes that really sit on `frame` — what the step's ring(s) are drawn around. */
  targets: Box[];
  /** Click points on `frame` when there's no highlight (a typed-into field): a crop hint only. */
  points: Point[];
  /** The step's own `callouts`/`blur` boxes were resolved on the manifest's `doc.image`; false
   * when `frame` is a different (earlier) frame, which this plan only picks for a step with no
   * callouts in a walkthrough with no blur entries at all, so nothing that needs hiding is ever
   * drawn from it. */
  docOverlays: boolean;
  /** First step of the guide, or the route changed since the previous step's screenshot: a
   * screen the reader hasn't seen yet, which print shows in full. */
  newScreen: boolean;
}

function pathnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://aida.invalid").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return undefined;
  }
}

/** The step's events as frames in order, each with the highlight boxes drawn while it showed. */
function frameSegments(step: ManifestStep): { frame: string; boxes: Box[]; clicks: Point[] }[] {
  const segs: { frame: string; boxes: Box[]; clicks: Point[] }[] = [];
  for (const e of step.events) {
    if (e.type === "frame") segs.push({ frame: e.image, boxes: [], clicks: [] });
    else if ((e.type === "scrollFrames" || e.type === "typeFrames") && e.images.length > 0) {
      segs.push({ frame: e.images[e.images.length - 1], boxes: [], clicks: [] });
    } else if (e.type === "highlight" && segs.length > 0) segs[segs.length - 1].boxes.push(e.box);
    else if (e.type === "click" && segs.length > 0) segs[segs.length - 1].clicks.push(e.at);
  }
  return segs;
}

/**
 * Plans every captured step's figure. A step's `doc.image` is the state after its actions, and
 * `doc.highlights` collects every box highlighted on the way there — so when a click moves to
 * another page, those boxes belong to the earlier frame, not the new page (a ring landing on an
 * empty part of the next screen). Then the frame the target was highlighted on is shown instead,
 * unless the step has callouts or any step has blur boxes (resolved on each `doc.image` only), in
 * which case it keeps `doc.image` with no ring. Steps with no image are left out.
 */
export function planStepFigures(wf: Pick<Walkthrough, "start" | "steps">, manifest: Pick<CaptureManifest, "steps">): StepFigurePlan[] {
  const plans: StepFigurePlan[] = [];
  // Blur boxes are resolved on each step's own `doc.image` only. An earlier frame can still show
  // something another step blurred (the previous step's screen, before this step's click), and
  // nothing would cover it there — so with blur anywhere in the walkthrough, never swap frames.
  const anyBlur = wf.steps.some((s) => (s.blur?.length ?? 0) > 0);
  let route = pathnameOf(wf.start?.page);
  let lastShownRoute: string | undefined;
  let first = true;
  for (let i = 0; i < manifest.steps.length; i++) {
    const m = manifest.steps[i];
    const wfStep = wf.steps[i];
    const before = route;
    const visited = (m.impact?.urls ?? []).map(pathnameOf).filter((p): p is string => Boolean(p));
    const after = visited.length > 0 ? visited[visited.length - 1] : before;
    const navigated = visited.some((p) => p !== before);
    route = after;
    const doc = m.doc.image;
    if (!doc) continue;

    const segs = frameSegments(m);
    const docSegs = segs.filter((s) => s.frame === doc);
    const onDoc = docSegs.flatMap((s) => s.boxes);
    const hasOverlays = anyBlur || (wfStep?.callouts?.length ?? 0) > 0;
    let plan: Omit<StepFigurePlan, "step" | "newScreen"> & { route: string | undefined };
    if (!navigated) {
      // Same page throughout: every highlight still points at the right thing on `doc.image`.
      const clicks = onDoc.length === 0 && m.doc.highlights.length === 0 ? segs.flatMap((s) => s.clicks).slice(-1) : [];
      plan = { frame: doc, targets: m.doc.highlights, points: clicks, docOverlays: true, route: after };
    } else if (onDoc.length > 0) {
      plan = { frame: doc, targets: onDoc, points: [], docOverlays: true, route: after };
    } else {
      const lastLit = [...segs].reverse().find((s) => s.boxes.length > 0 && s.frame !== doc);
      plan = lastLit && !hasOverlays
        ? { frame: lastLit.frame, targets: lastLit.boxes, points: [], docOverlays: false, route: before }
        : { frame: doc, targets: [], points: [], docOverlays: true, route: after };
    }
    const newScreen = first || plan.route !== lastShownRoute;
    plans.push({ step: i + 1, frame: plan.frame, targets: plan.targets, points: plan.points, docOverlays: plan.docOverlays, newScreen });
    lastShownRoute = plan.route;
    first = false;
  }
  return plans;
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * The focus crop for a step: the target(s) with enough surrounding UI to orient, held to a
 * sensible aspect and a minimum size, centred on the target and kept inside the frame. Undefined
 * when there's nothing to focus on, or the crop would cover most of the screen anyway (then the
 * full screen reads better).
 */
export function focusCrop(targets: Box[], viewport: { width: number; height: number }, points: Point[] = []): Box | undefined {
  const F = FOCUS_CROP;
  const t = targetBox(targets, points);
  if (!t) return undefined;
  let w = Math.max(F.minWidth, t.w + F.contextX * 2);
  let h = Math.max(w / F.aspect, t.h + F.contextY * 2);
  if (w / h > F.maxAspect) h = w / F.maxAspect;
  if (w / h < F.minAspect) w = h * F.minAspect;
  if (w > viewport.width * F.maxShare || h > viewport.height * F.maxShare) return undefined;
  const x = clamp(t.x + t.w / 2 - w / 2, 0, viewport.width - w);
  const y = clamp(t.y + t.h / 2 - h / 2, 0, viewport.height - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Where the screen's edges are, at one pixel per CSS px: a pixel counts as an edge when its
 * brightness differs from its left (`dx`) or upper (`dy`) neighbour by more than a small step —
 * text strokes, borders, panel boundaries. Prefix sums make any column/row/box count O(1).
 */
export interface EdgeMap {
  width: number;
  height: number;
  /** Column prefix sums of edge pixels: `colDx[x * (height + 1) + y]` = edges in rows `< y`.
   * Every edge counts (not only vertical ones), so a column through a field box — which only
   * meets its top and bottom borders — isn't mistaken for a clean gutter. */
  colDx: Uint32Array;
  /** Row prefix sums of edge pixels: `rowDy[y * (width + 1) + x]` = edges in columns `< x`. */
  rowDy: Uint32Array;
  /** 2-D prefix sums of all edge pixels, `(width + 1) * (height + 1)`. */
  all: Uint32Array;
}

const EDGE_STEP = 12;

/** Builds an `EdgeMap` from RGBA pixels (pngjs's `data`). */
export function edgeMap(rgba: Uint8Array | Buffer, width: number, height: number): EdgeMap {
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) lum[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const colDx = new Uint32Array(width * (height + 1));
  const rowDy = new Uint32Array(height * (width + 1));
  const all = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowAll = 0;
    for (let x = 0; x < width; x++) {
      const v = lum[y * width + x];
      const dx = x > 0 && Math.abs(v - lum[y * width + x - 1]) > EDGE_STEP ? 1 : 0;
      const dy = y > 0 && Math.abs(v - lum[(y - 1) * width + x]) > EDGE_STEP ? 1 : 0;
      const e = dx | dy;
      colDx[x * (height + 1) + y + 1] = colDx[x * (height + 1) + y] + e;
      rowDy[y * (width + 1) + x + 1] = rowDy[y * (width + 1) + x] + e;
      rowAll += e;
      all[(y + 1) * (width + 1) + x + 1] = all[y * (width + 1) + x + 1] + rowAll;
    }
  }
  return { width, height, colDx, rowDy, all };
}

/** Share of rows `[y0, y1)` where column `x` has an edge pixel. */
function colActivity(m: EdgeMap, x: number, y0: number, y1: number): number {
  if (x < 0 || x >= m.width || y1 <= y0) return 0;
  const base = x * (m.height + 1);
  return (m.colDx[base + y1] - m.colDx[base + y0]) / (y1 - y0);
}

/** Share of columns `[x0, x1)` where row `y` has an edge pixel. */
function rowActivity(m: EdgeMap, y: number, x0: number, x1: number): number {
  if (y < 0 || y >= m.height || x1 <= x0) return 0;
  const base = y * (m.width + 1);
  return (m.rowDy[base + x1] - m.rowDy[base + x0]) / (x1 - x0);
}

/** Share of edge pixels inside a box: how much there is to see. */
function density(m: EdgeMap, b: Box): number {
  const x0 = Math.max(0, Math.round(b.x)), y0 = Math.max(0, Math.round(b.y));
  const x1 = Math.min(m.width, Math.round(b.x + b.w)), y1 = Math.min(m.height, Math.round(b.y + b.h));
  if (x1 <= x0 || y1 <= y0) return 0;
  const W = m.width + 1;
  return (m.all[y1 * W + x1] - m.all[y0 * W + x1] - m.all[y1 * W + x0] + m.all[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
}

/** Tuning for `refineCrop`. */
export const CROP_REFINE = {
  /** Smaller sizes tried (share of the planned crop) when the area around the target is sparse. */
  scales: [1, 0.85, 0.72],
  /** Smallest crop width, CSS px. */
  minWidth: 340,
  /** Space always kept between the target and a crop edge. */
  margin: 20,
  /** A column/row with an edge on at least this share of the crop is a boundary (a sidebar, a
   * panel's border): a strip of another region beyond it is cut off. */
  boundary: 0.5,
  /** Biggest strip (share of the crop's width/height) cut off past a boundary. */
  sliverShare: 0.22,
  /** A crop edge where no column/row of the 5 around it has more activity than this is a clean
   * gutter (at most a stray pixel — nothing sliced). */
  gutter: 0.005,
  /** How far an edge grows looking for a gutter, CSS px. */
  gutterReach: 72,
  /** How far an edge shrinks looking for a gutter (share of the crop), so a neighbouring column
   * of content is dropped whole rather than sliced. */
  gutterShrinkShare: 0.4,
} as const;

function targetBox(targets: Box[], points: Point[]): Box | undefined {
  const F = FOCUS_CROP;
  const boxes = targets.length > 0
    ? targets
    : points.map((p) => ({ x: p.x - F.pointBox.left, y: p.y - F.pointBox.h / 2, w: F.pointBox.left + F.pointBox.right, h: F.pointBox.h }));
  if (boxes.length === 0) return undefined;
  const u = union(boxes);
  return { x: u.x - F.pad, y: u.y - F.pad, w: u.w + F.pad * 2, h: u.h + F.pad * 2 };
}

/** Picks where (and how big) the crop sits: the candidate with the most to see around the
 * target, the target nearest its centre, and — other things equal — the larger size. */
function placeCrop(m: EdgeMap, crop: Box, t: Box, vw: number, vh: number): Box {
  const R = CROP_REFINE;
  const aspect = crop.w / crop.h;
  let best = crop;
  let bestScore = -Infinity;
  for (const s of R.scales) {
    const w = Math.min(vw, Math.max(crop.w * s, R.minWidth, t.w + R.margin * 2));
    const h = Math.min(vh, Math.max(w / aspect, t.h + R.margin * 2));
    const xs = [Math.max(0, t.x + t.w + R.margin - w), Math.min(vw - w, t.x - R.margin)];
    const ys = [Math.max(0, t.y + t.h + R.margin - h), Math.min(vh - h, t.y - R.margin)];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 8) {
      for (let y = Math.min(...ys); y <= Math.max(...ys); y += 8) {
        const b = { x: clamp(x, 0, vw - w), y: clamp(y, 0, vh - h), w, h };
        const off = Math.max(Math.abs(t.x + t.w / 2 - (b.x + w / 2)) / (w / 2), Math.abs(t.y + t.h / 2 - (b.y + h / 2)) / (h / 2));
        const score = (density(m, b) + 0.002) * (1 - 0.6 * Math.min(off, 1)) * Math.sqrt(w / crop.w);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
    }
  }
  return best;
}

/** Moves one crop edge off a cut: past a boundary with only a sliver beyond it, then onto the
 * nearest clean gutter (shrinking first, never into the target, never back across a boundary). */
function snapEdge(
  pos: number,
  dir: 1 | -1,
  limit: number,
  frameEdge: number,
  span: number,
  activity: (p: number) => number,
): number {
  const R = CROP_REFINE;
  // `dir` points inward (towards the target). `limit` is the furthest inward the edge may go.
  const inward = (p: number) => (dir === 1 ? p <= limit : p >= limit);
  const reach = Math.floor(span * R.sliverShare);
  let p = pos;
  for (let d = 1; d <= reach; d++) {
    const q = pos + dir * d;
    if (!inward(q)) break;
    if (activity(q) >= R.boundary) p = q;
  }
  const smooth = (q: number) => Math.max(activity(q - 2), activity(q - 1), activity(q), activity(q + 1), activity(q + 2));
  if (smooth(p) <= R.gutter) return p;
  const shrinkReach = Math.max(R.gutterReach, Math.floor(span * R.gutterShrinkShare));
  let canGrow = true;
  // Without a clean gutter (a full-width field crosses every gap), settle for the quietest
  // column/row in reach when it cuts through clearly less than where the edge is now.
  let quiet = p;
  let quietScore = smooth(p);
  const consider = (q: number) => {
    const v = smooth(q);
    if (v < quietScore) {
      quiet = q;
      quietScore = v;
    }
  };
  for (let d = 1; d <= shrinkReach; d++) {
    const inQ = p + dir * d;
    if (inward(inQ)) {
      if (smooth(inQ) <= R.gutter) return inQ;
      consider(inQ);
    }
    if (!canGrow || d > R.gutterReach) continue;
    const outQ = p - dir * d;
    // Never grow past the frame; growing up to a boundary (a region's own edge) stops right on
    // it — a clean cut, with nothing of the next region let back in.
    if (dir === 1 ? outQ < frameEdge : outQ > frameEdge) canGrow = false;
    else if (activity(outQ) >= R.boundary) return outQ;
    else if (smooth(outQ) <= R.gutter) return outQ;
    else consider(outQ);
  }
  return quietScore < smooth(p) * 0.5 ? quiet : p;
}

/**
 * Refines a planned focus crop against the screen itself (`m`, the clean full screen's edges):
 * places it where there's most to see around the target (a sparse area gets a tighter crop,
 * and the target sits near the centre), then moves each edge so it doesn't slice through UI —
 * cutting off a sliver of a neighbouring region (a sidebar, the next panel) and settling on a
 * clean gutter rather than through text. The target and a margin around it always stay in.
 */
export function refineCrop(m: EdgeMap, crop: Box, targets: Box[], points: Point[] = []): Box {
  const t = targetBox(targets, points);
  if (!t) return crop;
  const R = CROP_REFINE;
  const vw = m.width, vh = m.height;
  const b = placeCrop(m, crop, t, vw, vh);
  let x0 = Math.round(b.x), y0 = Math.round(b.y), x1 = Math.round(b.x + b.w), y1 = Math.round(b.y + b.h);
  const tx0 = Math.floor(t.x - R.margin), ty0 = Math.floor(t.y - R.margin);
  const tx1 = Math.ceil(t.x + t.w + R.margin), ty1 = Math.ceil(t.y + t.h + R.margin);
  // Columns first (left/right), measured over the crop's rows; then rows over the new columns.
  x0 = snapEdge(x0, 1, Math.max(x0, tx0), 0, x1 - x0, (p) => colActivity(m, p, y0, y1));
  x1 = snapEdge(x1, -1, Math.min(x1, tx1), vw, x1 - x0, (p) => colActivity(m, p, y0, y1));
  // Snapping columns can leave a tall strip (or a thin band): bring the height back into the
  // aspect range around the target before snapping the rows.
  const w = x1 - x0;
  const minH = Math.min(ty1 - ty0, vh);
  const wantH = clamp(y1 - y0, Math.max(w / FOCUS_CROP.maxAspect, minH), Math.max(w / FOCUS_CROP.minAspect, minH));
  if (wantH !== y1 - y0) {
    const cy = t.y + t.h / 2;
    y0 = Math.round(clamp(Math.min(cy - wantH / 2, ty0), 0, vh - wantH));
    y1 = Math.round(Math.min(vh, Math.max(y0 + wantH, ty1)));
  }
  y0 = snapEdge(y0, 1, Math.max(y0, ty0), 0, y1 - y0, (p) => rowActivity(m, p, x0, x1));
  y1 = snapEdge(y1, -1, Math.min(y1, ty1), vh, y1 - y0, (p) => rowActivity(m, p, x0, x1));
  x0 = clamp(x0, 0, vw); x1 = clamp(x1, x0 + 1, vw);
  y0 = clamp(y0, 0, vh); y1 = clamp(y1, y0 + 1, vh);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
