/**
 * Normalized slide model — the single representation both the PDF and the HTML
 * adapters emit, and the only thing the PPTX writer reads.
 *
 * Coordinates are PDF points throughout; conversion to EMU/inches happens once,
 * at emit time. Every object carries provenance so a shape in the output can
 * always be traced back to the glyphs it came from.
 */
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import { extractGlyphs, buildLines, blockRuns, blockText, blockIsRtl, sourceEvidence } from "../extract/glyphs.js";
import { makeFontResolver } from "../fonts/resolve.js";
import { fontDescriptors } from "../fonts/type3.js";
import { extractVectors, cornerRadius } from "../extract/vectors.js";
import { detectTables } from "../extract/tables.js";
import { cacheImage } from "./images.js";
import { ligatureArity } from "../extract/cff-names.js";
import { release } from "../extract/mupdf-lifetime.js";
import { paragraphDirection } from "./direction.js";

export const SCHEMA_VERSION = "1.0";

const RE_ARABIC = /[؀-ۿݐ-ݿ]/;


/**
 * Font resolution is delegated to src/fonts/resolve.js, which checks what is
 * actually installed. String munging alone gets it wrong: "DiodrumArabic-Bold"
 * is a family plus a bold attribute, but "LyonArabicTextLF-Bold" is a family
 * whose NAME contains the weight, and applying bold to that one asks PowerPoint
 * to synthesise a second layer of weight.
 */
export const resolveFont = makeFontResolver();

/**
 * A STRUCTURED-TEXT colour -> "RRGGBB".
 *
 * Structured text carries no colorspace, and MEASURED across 397k glyphs from
 * eight producers (Chrome, PowerPoint, Word, LaTeX, InDesign, Acrobat) it always
 * reports three components — so a triple is a safe premise HERE and only here.
 * The device path is a different story and must read its colorspace: the same
 * sentence written above `toHex` in `src/extract/vectors.js` was false, and it
 * shipped every white DeviceGray fill as black. See that file for the numbers.
 */
export function toHex(color) {
  if (!Array.isArray(color)) return "000000";
  return color
    .slice(0, 3)
    .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * One extracted vector -> a model shape.
 *
 * `strategy` records how faithfully we can represent it: `native_shape` means
 * PowerPoint has a primitive for it, anything else is a declared degradation
 * that the doctor will surface rather than let it pass silently.
 */
function shapeObject(v, i, pageIndex, bx0, by0) {
  const NATIVE = new Set(["rect", "roundRect", "ellipse", "line"]);
  const pts = v.subpaths[0] ? v.subpaths[0].points : [];

  return {
    id: `p${pageIndex}_shape_${String(i).padStart(3, "0")}`,
    type: "shape",
    shapeType: v.shape,
    zIndex: v.paintSeq,
    bbox: {
      x: +(v.bbox.x0 - bx0).toFixed(2),
      y: +(v.bbox.y0 - by0).toFixed(2),
      w: +v.bbox.w.toFixed(2),
      h: +v.bbox.h.toFixed(2),
    },
    fill: v.kind === "fill" ? v.fill : null,
    stroke: v.kind === "stroke" ? v.stroke : null,
    strokeWidth: v.kind === "stroke" ? v.strokeWidth : 0,
    dashed: Array.isArray(v.dashes) && v.dashes.length > 0,
    opacity: v.alpha ?? 1,
    // WHICH DIAGONAL. A bbox cannot tell (0,0)->(w,h) from (0,h)->(w,0): both
    // have the same box, and PowerPoint's `line` preset always draws the first.
    // So every ASCENDING line came out mirrored — measured on the p103 chart,
    // where the rising holding-cost line rendered as a falling one. Device y
    // grows downward, so a line whose y falls as x rises is the ascending one.
    ...(v.shape === "line" && risesLeftToRight(v.subpaths) ? { flipV: true } : {}),
    cornerRadiusPt: v.shape === "roundRect"
      ? +(v.cornerRadiusPt ?? cornerRadius(pts, v.bbox)).toFixed(2)
      : 0,
    reconstructionStrategy: v.reconstructionStrategy ?? (NATIVE.has(v.shape) ? "native_shape" : "unsupported"),
    provenance: {
      sourcePage: pageIndex,
      sourceType: v.sourceType ?? "vector",
      paintSeq: v.paintSeq,
      geometrySource: "mupdf-device",
      clipped: v.clipped,
      pointCount: pts.length,
    },
  };
}

const round2 = (n) => +n.toFixed(2);

/**
 * Does this line run bottom-left to top-right, as drawn on the page?
 *
 * Only meaningful for a 2-point path. Device space puts y at the TOP, so a line
 * that climbs on screen has y DECREASING as x increases — the product of the two
 * deltas is negative. A near-horizontal or near-vertical rule has no meaningful
 * diagonal and must not be flipped, so both deltas have to be real.
 */
const DIAGONAL_EPS = 0.5;
function risesLeftToRight(subpaths) {
  const pts = subpaths?.length === 1 ? subpaths[0].points : null;
  if (!pts || pts.length < 2) return false;
  // Points are [x, y] pairs, not {x, y} objects.
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.abs(dx) < DIAGONAL_EPS || Math.abs(dy) < DIAGONAL_EPS) return false;
  return dx * dy < 0;
}

/**
 * PowerPoint has one slide size for the whole presentation; PDFs do not.
 *
 * A merged 118-page lecture supplied by the user proved this is not theoretical:
 * pages 1-63 and 95-118 are 713.04x487.92pt, while pages 64-94 are roughly
 * 750x750pt. Copying those square-page coordinates onto the first landscape
 * canvas stretched, clipped and displaced every object on 31 slides.
 *
 * Choose the document's dominant page size, then uniformly fit every other page
 * inside it. Text, shapes, images and table metadata all receive the SAME affine
 * transform, so nothing can drift relative to anything else. Empty side bands
 * are preferable to distortion and are the only faithful answer a single-size
 * PowerPoint deck can represent.
 */
export function fitPagesToCanvas(pages) {
  if (!pages.length) return { widthPt: 0, heightPt: 0, fittedPages: 0 };

  // Half-point buckets absorb harmless crop-box rounding without allowing a
  // genuinely different page size to disappear into the dominant group.
  const groups = new Map();
  for (const page of pages) {
    const key = `${Math.round(page.widthPt * 2) / 2}x${Math.round(page.heightPt * 2) / 2}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { count: 1, widthPt: page.widthPt, heightPt: page.heightPt });
  }
  const canvas = [...groups.values()].reduce((best, group) =>
    !best || group.count > best.count ? group : best, null);

  let fittedPages = 0;
  for (const page of pages) {
    const source = { widthPt: page.widthPt, heightPt: page.heightPt };
    const scale = Math.min(canvas.widthPt / source.widthPt, canvas.heightPt / source.heightPt);
    const offsetX = (canvas.widthPt - source.widthPt * scale) / 2;
    const offsetY = (canvas.heightPt - source.heightPt * scale) / 2;
    const changed = Math.abs(scale - 1) > 0.0001 || Math.abs(offsetX) > 0.05 || Math.abs(offsetY) > 0.05;

    page.sourceSizePt = source;
    page.sourceFit = {
      scale: +scale.toFixed(6),
      x: round2(offsetX),
      y: round2(offsetY),
      fitted: changed,
    };
    page.widthPt = canvas.widthPt;
    page.heightPt = canvas.heightPt;
    if (!changed) continue;
    fittedPages++;

    const length = (v) => round2(v * scale);
    const x = (v) => round2(offsetX + v * scale);
    const y = (v) => round2(offsetY + v * scale);
    const box = (b) => ({ x: x(b.x), y: y(b.y), w: length(b.w), h: length(b.h) });

    for (const obj of page.objects) {
      obj.bbox = box(obj.bbox);
      // A clipped picture carries a SECOND rectangle, and the two are only
      // meaningful together — fitting one without the other would compute the
      // crop from mismatched coordinate spaces.
      if (obj.type === "image" && obj.clippedFrom) obj.clippedFrom = box(obj.clippedFrom);
      if (obj.type === "shape") {
        obj.strokeWidth = length(obj.strokeWidth ?? 0);
        obj.cornerRadiusPt = length(obj.cornerRadiusPt ?? 0);
      }
      if (obj.type === "text") {
        obj.baselinePt = y(obj.baselinePt ?? 0);
        for (const run of obj.runs ?? []) {
          run.fontSizePt = length(run.fontSizePt);
          if (run.srcX != null) run.srcX = x(run.srcX);
          if (run.srcW != null) run.srcW = length(run.srcW);
          if (run.lift != null) run.lift = length(run.lift);
        }
        for (const segment of obj.tableSegments ?? []) {
          segment.bbox = box(segment.bbox);
          // The recorded ink extent is in the same space as the box and has to
          // travel with it, or it describes the unfitted page while everything
          // around it describes the fitted one.
          if (segment.srcInk) segment.srcInk = { x: x(segment.srcInk.x), w: length(segment.srcInk.w) };
          for (const run of segment.runs ?? []) {
            run.fontSizePt = length(run.fontSizePt);
            if (run.srcX != null) run.srcX = x(run.srcX);
            if (run.srcW != null) run.srcW = length(run.srcW);
            if (run.lift != null) run.lift = length(run.lift);
          }
        }
      }
    }

    for (const table of page.tables ?? []) {
      table.bbox = box(table.bbox);
      table.rowLines = (table.rowLines ?? []).map(y);
      table.colLines = (table.colLines ?? []).map(x);
      for (const cell of table.cells ?? []) cell.bbox = box(cell.bbox);
    }
  }

  return { widthPt: canvas.widthPt, heightPt: canvas.heightPt, fittedPages };
}

/** Build the normalized model for a whole PDF. */
export function modelFromPdf(pdfPath, { pages } = {}) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf");
  try {
  // MuPDF labels an unnamed Type3 font "Type3 (4 0 R)". On this corpus those are
  // the title-slide HEADINGS, and the font dictionary both names them and states
  // the weight they were drawn at, so harvest the descriptors before anything
  // downstream tries to resolve a font.
  const descriptors = fontDescriptors(doc);
  // What each embedded font calls its own ligature glyphs. Read once per
  // document: `owedOf` knows one family and this font names 422 more, which is
  // the difference between a lost letter being visible and being silent.
  let arity = new Map();
  try { arity = ligatureArity(doc.asPDF?.()); } catch { /* not a PDF we can open twice */ }
  const count = doc.countPages();
  const wanted = pages ?? [...Array(count).keys()];

  const out = {
    schemaVersion: SCHEMA_VERSION,
    document: { sourceType: "pdf", sourceFile: pdfPath, pageCount: count },
    pages: [],
    rawCounts: [],
  };

  for (const index of wanted) {
    const page = doc.loadPage(index);
    try {
    const [bx0, by0, bx1, by1] = page.getBounds();
    const glyphs = extractGlyphs(page, arity);
    const blocks = buildLines(glyphs);
    // Which of these lines the PAGE says are missing characters. Computed here,
    // where the device evidence still exists, and carried on the object: the
    // doctor runs in the browser over a JSON model and can never ask mupdf.
    const evidence = sourceEvidence(blocks, glyphs.deviceGlyphs, (b) => blockText(b, blockIsRtl(b)),
      glyphs.shadowRowGlyphs);

    const {
      vectors, images, textPaints, unsupported,
      shadeCount = 0, shadeCallbackCount = shadeCount, shadeSkippedCount = 0,
    } = extractVectors(page);

    // Full-page fills painted before any text are the slide background, not
    // shapes. Keeping them as objects would put an opaque rectangle over the
    // whole slide in the editor.
    const pageArea = (bx1 - bx0) * (by1 - by0);
    const firstTextSeq = textPaints.length ? Math.min(...textPaints.map((t) => t.paintSeq)) : Infinity;
    const bgCandidates = vectors.filter(
      (v) => !v.rasterized && v.kind === "fill" && v.paintSeq < firstTextSeq &&
        v.bbox.w * v.bbox.h >= pageArea * 0.98
    );
    const background = bgCandidates.length ? bgCandidates[bgCandidates.length - 1].fill : null;
    const bgSeqs = new Set(bgCandidates.map((v) => v.paintSeq));

    /**
     * Z-order. Glyphs and vectors come from two different walkers with separate
     * counters, so a text block's true depth is the paint sequence of the
     * device-level text events that cover it. Measured: vectors and text
     * interleave on every page in this corpus, so "shapes first" is wrong.
     *
     * TAKE THE LAST OF THOSE EVENTS, NOT THE FIRST. A reconstructed block is a
     * MERGE of glyphs the PDF painted at different times, and a shape drawn
     * between the first and the last of them would otherwise sort above the
     * whole line. Measured on Chp1-Lec3-2 slide 10, the line
     * "الخطوة 2 — إجمالي العيوب  =SUM(C3:L3)":
     *
     *     seq 404   one glyph at the left edge
     *     seq 405   the white roundRect field box      <- fill
     *     seq 406   its purple border                  <- stroke
     *     seq 407..430  the formula, painted ON TOP of that box
     *
     * `min` gave the block 404, so the box covered its own formula — the white
     * rectangles the user found text hiding behind. The block must sit above
     * everything drawn before its LAST glyph; anything painted after that still
     * sorts above it and legitimately covers it.
     *
     * Candidates are events whose CENTRE falls inside the block, not merely ones
     * that touch it. A neighbouring line's box often clips this one, and with a
     * max that would borrow an unrelated later sequence and lift the block over
     * a shape that should cover it — the same class of error in the opposite
     * direction.
     */
    const zOf = (bbox) => {
      let centred = -Infinity, touching = -Infinity;
      for (const t of textPaints) {
        if (t.bbox.x1 < bbox.x0 || t.bbox.x0 > bbox.x1 || t.bbox.y1 < bbox.y0 || t.bbox.y0 > bbox.y1) continue;
        if (t.paintSeq > touching) touching = t.paintSeq;
        const cx = (t.bbox.x0 + t.bbox.x1) / 2, cy = (t.bbox.y0 + t.bbox.y1) / 2;
        const inside = cx >= bbox.x0 && cx <= bbox.x1 && cy >= bbox.y0 && cy <= bbox.y1;
        if (inside && t.paintSeq > centred) centred = t.paintSeq;
      }
      // Measured across the corpus: the centre test leaves 19 of 2454 blocks with
      // no candidate at all (the overlap test leaves none). Dropping those to
      // firstTextSeq would park them at the very bottom of the text stack — the
      // same "hidden behind a shape" failure this change exists to remove — so
      // the looser test is the fallback rather than the page floor.
      if (centred > -Infinity) return centred;
      if (touching > -Infinity) return touching;
      return firstTextSeq;
    };

    const normalizedRuns = (block, isRtl) => blockRuns(block, isRtl).map((r) => {
      // The DESCRIPTOR outranks the name. A subset name is a leftover from
      // whatever cut the producer started from, while FontWeight is its
      // explicit statement of what it drew. Measured: every Type3 heading on
      // slide 1 is named Cairo-ExtraLight and declares FontWeight 700, so
      // trusting the name rendered every bold heading thin.
      const desc = descriptors.get(r.family);
      const font = resolveFont(desc?.name ?? r.family, desc);
      return {
        text: r.text,
        ...(r.lift ? { lift: r.lift } : {}),
        // Where this run's glyphs actually sat on the page. Needed because a
        // line's INTERNAL layout is PowerPoint's, not the source's, so a run
        // in the middle of a right-aligned line drifts out of its source box.
        srcX: r.x0 == null ? null : +(r.x0 - bx0).toFixed(2),
        srcW: r.x0 == null ? null : +(r.x1 - r.x0).toFixed(2),
        fontFamily: font.face,
        bold: font.bold,
        italic: font.italic,
        fontSizePt: +r.size.toFixed(2),
        color: toHex(r.color),
        script: r.script ?? (RE_ARABIC.test(r.text) ? "Arab" : "Latn"),
        fontRequested: font.requested,
        fontSubstituted: font.substituted,
        weightRequested: font.weightRequested,
        weightDelivered: font.weightDelivered,
        weightApprox: font.weightApprox,
        weightSynthesised: font.weightSynthesised,
      };
    });

    // Retained only until table detection. It lets the table overlay split a
    // merged baseline at real cell boundaries without changing the source block
    // itself (and therefore without making the delivered-text gate key on new
    // geometry). The glyph arrays never enter the JSON model.
    const sourceBlocks = new Map();

    const objects = blocks.map((b, i) => {
      // Direction comes from the glyphs, once, and drives both text and runs.
      // This is the RECONSTRUCTION answer and nothing else: which base direction
      // turns the painted stream back into a logical string. What the
      // DESTINATION should be told is a separate question with a separate
      // answer — src/model/direction.js.
      const isRtl = blockIsRtl(b);
      const sourceStreamDirection = isRtl ? "rtl" : "ltr";
      const text = blockText(b, isRtl);
      const runs = normalizedRuns(b, isRtl);
      const id = `p${index}_text_${String(i).padStart(3, "0")}`;
      sourceBlocks.set(id, b);

      return {
        id,
        type: "text",
        bbox: {
          x: +(b.x0 - bx0).toFixed(2),
          y: +(b.yTop - by0).toFixed(2),
          w: +(b.x1 - b.x0).toFixed(2),
          h: +(b.yBot - b.yTop).toFixed(2),
        },
        baselinePt: +b.y.toFixed(2),
        // Non-zero only for a line the page painted on a rotated baseline (a
        // chart axis caption). `bbox` above stays the axis-aligned INK extent;
        // write.js converts it to the unrotated box PowerPoint rotates about
        // its own centre.
        ...(b.rotation ? { rotation: b.rotation } : {}),
        zIndex: zOf({ x0: b.x0, y0: b.yTop, x1: b.x1, y1: b.yBot }),
        text,
        sourceStreamDirection,
        paragraphDirection: paragraphDirection(text, sourceStreamDirection),
        // Alignment stays on the SOURCE answer on purpose. It records which
        // edge the page anchored the ink to, which is a geometric fact and not
        // a statement about bidi — deriving it from the narrowed direction
        // would move every one of the 102 narrowed paragraphs sideways.
        alignment: sourceStreamDirection === "rtl" ? "right" : "left",
        runs,
        reconstructionStrategy: "native_text",
        // The page paints more characters than this line carries, so letters
        // were lost. Measured at 100% precision over 10206 blocks — see
        // `sourceEvidence`. Null on every line the evidence clears.
        charactersMissing: evidence.get(b)?.missing || null,
        // A lam-alef ligature the text does not account for. This decides what a
        // repair puts BACK — `لا` rather than a bare alef — and it must be the
        // per-ligature reading, not the line's total deficit.
        lamAlefLost: evidence.get(b)?.lamAlefLost ?? false,
        provenance: {
          sourcePage: index,
          glyphCount: b.glyphs.length,
          // Ink the extractor deliberately removed (an orphan tanween the source
          // never wrote). Carried so the coverage ledger can account for it
          // instead of reporting a silent loss.
          droppedGlyphs: b.droppedGlyphs ?? 0,
          paintSequence: [b.glyphs[0]?.paintSeq, b.glyphs[b.glyphs.length - 1]?.paintSeq],
          geometrySource: "mupdf",
          textSource: "native_bidi_reconstruction",
        },
      };
    });

    const shapeObjects = vectors
      .filter((v) => !v.rasterized && !bgSeqs.has(v.paintSeq))
      .map((v, i) => shapeObject(v, i, index, bx0, by0));

    const imageObjects = images.map((im, i) => {
      const placed = {
        x: +(im.bbox.x0 - bx0).toFixed(2), y: +(im.bbox.y0 - by0).toFixed(2),
        w: +im.bbox.w.toFixed(2), h: +im.bbox.h.toFixed(2),
      };
      // A page that places a large picture and clips it to a small frame must
      // ship the FRAME, not the placement. `visibleBbox` is set by the extractor
      // only when the clip stack genuinely tightens the rectangle, so a document
      // that never clips an image is untouched by this. The pixels are NOT
      // cropped — `clippedFrom` lets the writer ask PowerPoint for a srcRect —
      // so identical images still share one entry in the content-hash cache.
      const visible = im.visibleBbox;
      const clipped = "visibleBbox" in im;
      const bbox = clipped && visible ? {
        x: +(visible.x0 - bx0).toFixed(2), y: +(visible.y0 - by0).toFixed(2),
        w: +visible.w.toFixed(2), h: +visible.h.toFixed(2),
      } : placed;
      // An image the page placed into no area paints nothing. Say so rather than
      // asking PowerPoint to draw a zero-height picture: these are real in this
      // corpus (a 323x1 strip whose transform collapses it entirely). A clip
      // that leaves nothing is the same statement made by a different mechanism.
      const degenerate = (clipped && !visible) || bbox.w < 0.5 || bbox.h < 0.5;
      return {
        id: `p${index}_image_${String(i).padStart(3, "0")}`,
        type: "image",
        zIndex: im.paintSeq,
        bbox,
        pixels: { w: im.widthPx, h: im.heightPx },
        opacity: im.alpha,
        // The pixels themselves live in .cache/images — see src/model/images.js
        // for why they cannot travel inside a model that round-trips as JSON.
        ref: cacheImage(im.bytes, im.format),
        format: im.format ?? null,
        isMask: im.isMask ?? false,
        decodeError: im.decodeError ?? null,
        reconstructionStrategy: degenerate ? "degenerate" : (im.reconstructionStrategy ?? "native_image"),
        isShade: im.isShade ?? false,
        isVectorFallback: im.isVectorFallback ?? false,
        // The full placed rectangle, kept ONLY when a clip made it bigger than
        // what is visible. The writer needs both to compute PowerPoint's
        // srcRect; nothing else should read it as geometry — `bbox` is the
        // frame, and it is what the editor, the z-order and the overlap gates see.
        ...(clipped && visible ? { clippedFrom: placed } : {}),
        // A rotated or skewed placement cannot be cropped to an axis-aligned
        // sub-rectangle, so it keeps the whole placement. Countable, not silent.
        ...(im.clipUnappliable ? { clipUnappliable: true } : {}),
        provenance: {
          sourcePage: index, paintSeq: im.paintSeq, geometrySource: "mupdf-device",
          sourceType: im.sourceType ?? "image",
        },
      };
    });

    // Tables are a STRUCTURAL overlay: they group rules and bind text to cells
    // so the editor can treat them as tables, without changing what is emitted.
    // Handing layout to a DrawingML table would let PowerPoint pick cell sizes
    // and wrapping, which is exactly the surprise this project avoids.
    const textToCell = new Map();
    const tables = detectTables(shapeObjects, objects);

    // A baseline can cross several table cells while still being one extracted
    // block. Emitting that block as one PowerPoint textbox lets the renderer
    // reflow eight headers into each other (measured on field page 113). Keep the
    // stable source object for scoring/editing, but add cell-sized render units
    // rebuilt from the ORIGINAL glyphs. This changes no block id or source text,
    // so the delivered-text regression gate remains meaningful.
    const charBag = (s) => [...s.replace(/\s/g, "")].sort().join("");
    for (const table of tables) {
      const byRow = new Map();
      for (const cell of table.cells) byRow.set(cell.row, [...(byRow.get(cell.row) ?? []), cell]);

      for (const o of objects) {
        const block = sourceBlocks.get(o.id);
        if (!block?.glyphs?.length) continue;
        const cy = o.bbox.y + o.bbox.h / 2;
        const row = [...byRow.values()].find((cells) =>
          cy >= cells[0].bbox.y - 0.5 && cy <= cells[0].bbox.y + cells[0].bbox.h + 0.5);
        if (!row) continue;
        const groups = new Map();
        let assigned = 0;
        for (const glyph of block.glyphs) {
          const gx = ((glyph.x0 + glyph.x1) / 2) - bx0;
          const cell = row.find((c) => gx >= c.bbox.x - 0.5 && gx <= c.bbox.x + c.bbox.w + 0.5);
          if (!cell) continue;
          groups.set(cell, [...(groups.get(cell) ?? []), glyph]);
          assigned++;
        }
        if (!groups.size || assigned < block.glyphs.length * 0.8) continue;

        const segments = [...groups.entries()]
          .sort((a, b) => a[0].col - b[0].col)
          .map(([cell, glyphs]) => {
            const part = { ...block, glyphs };
            // WHERE THE PAGE ACTUALLY PUT THIS CELL'S INK, in model coordinates.
            // The segment's own box is the CELL, which says nothing about how the
            // text sits inside it, and the glyphs are the only record of that.
            const srcInk = {
              x: +(Math.min(...glyphs.map((g) => g.x0)) - bx0).toFixed(2),
              w: +(Math.max(...glyphs.map((g) => g.x1)) - Math.min(...glyphs.map((g) => g.x0))).toFixed(2),
            };
            const isRtl = blockIsRtl(part);
            let text = blockText(part, isRtl);
            let sourceStreamDirection = isRtl ? "rtl" : "ltr";
            let runs = normalizedRuns(part, isRtl);

            // A compact service-level expression is a two-level bidi island:
            // the PDF paints `)Z=2.33( 99%`, while the visible left-to-right ink
            // in the RTL cell is `(Z=2.33) 99%`. Neither one-level base
            // direction can reach it.
            // This exact grammar occurs three times on field page 113 and costs
            // no protected site; rebuild it from the measured visual glyphs.
            const visual = glyphs.map((g) => g.c).join("").replace(/\s+/g, " ").trim();
            const service = visual.match(/^\)Z=([0-9]+(?:\.[0-9]+)?)\(\s*([0-9]+)%$/);
            if (service) {
              text = `(Z=${service[1]}) ${service[2]}%`;
              sourceStreamDirection = "ltr";
              const style = runs.find((r) => r.fontFamily !== "Segoe UI") ?? runs[0];
              runs = [{ ...style, text, script: "Latn" }];
            }
            return {
              cell: { row: cell.row, col: cell.col },
              // The CELL decides the horizontal band — that is the whole point of
              // binding text to a table — but the LINE keeps its own vertical
              // position. Taking the cell's y and h too gives every line in a
              // multi-line cell the SAME box, and since each is emitted
              // `valign: middle`, they are all centred in that identical box and
              // drawn on top of one another.
              //
              // MEASURED on the 118-page Unit Five deck: 13 pairs over 5 pages,
              // e.g. `c=16` painted onto `82` in one supply-table cell, and
              // `56×4 = 224` onto the line below it. The source stacks them
              // 9.75pt apart; the cell is 39pt tall, so both line centres fall
              // inside it and both resolved to the same row and cell.
              //
              // AND THE HORIZONTAL BAND IS THE INK, NOT THE CELL. Taking the
              // cell's x and w and centring inside it discards where the page
              // actually set the text: a cell is padded, and an Arabic table
              // anchors its text to the RIGHT of a 360pt column, so a two-word
              // entry is moved half the column away. MEASURED over 29 documents
              // and 3838 cell segments: the source anchors 2511 right, 1203
              // centred, 71 left, and centring displaces 65.97% of them by more
              // than 2pt, 51.22% by more than 10pt, p50 10.70pt and max 192.48pt.
              // Reported as `«78»` rendering 125pt from where the source paints
              // it on Chp1-Lec1-3(New) p17, which reads as a missing block.
              //
              // Splitting the line per cell is what stops eight headers reflowing
              // into each other; the box being the CELL rather than the ink was
              // never part of that and is dropped. Every other text block in this
              // model is boxed at its own ink with its direction's anchor, and a
              // cell is now no different.
              bbox: {
                x: +srcInk.x.toFixed(2),
                y: +o.bbox.y.toFixed(2),
                w: +Math.max(0.5, srcInk.w).toFixed(2),
                h: +o.bbox.h.toFixed(2),
              },
              text,
              sourceStreamDirection,
              paragraphDirection: paragraphDirection(text, sourceStreamDirection),
              srcInk,
              alignment: sourceStreamDirection === "rtl" ? "right" : "left",
              runs,
              ...(service ? { nestedBidiRepair: "service-level" } : {}),
            };
          })
          .filter((segment) => segment.text);

        // A segmentation hint may move characters between boxes; it may never
        // change which characters the stable source block delivers.
        if (!segments.length || charBag(segments.map((s) => s.text).join("")) !== charBag(o.text)) continue;
        o.tableSourceText = o.text;
        o.tableSegments = segments;
        o.inTable = { rows: table.rows, cols: table.cols };
        o.provenance.tableSegmentCount = segments.length;
      }
    }

    for (const t of tables) {
      for (const cell of t.cells) for (const id of cell.textIds) textToCell.set(id, t);
    }
    for (const o of objects) {
      const t = textToCell.get(o.id);
      if (t) o.inTable = { rows: t.rows, cols: t.cols };
    }

    out.rawCounts.push({
      page: index,
      glyphCount: glyphs.length,
      vectorCount: vectors.filter((v) => v.sourceType !== "shade").length,
      imageCount: images.filter((im) => !im.isShade && !im.isVectorFallback).length,
      shadeCount,
      shadeCallbackCount,
      shadeSkippedCount,
      backgroundCount: bgSeqs.size,
      backgroundVectorCount: bgCandidates.filter((v) => v.sourceType !== "shade").length,
      backgroundShadeCount: bgCandidates.filter((v) => v.sourceType === "shade").length,
    });

    out.pages.push({
      index,
      widthPt: +(bx1 - bx0).toFixed(2),
      heightPt: +(by1 - by0).toFixed(2),
      background,
      tables,
      // One list in true paint order — z-order is evidence, not an assumption.
      objects: [...shapeObjects, ...imageObjects, ...objects].sort((a, b) => a.zIndex - b.zIndex),
    });
    } finally {
      release(page);
    }
  }

  const fit = fitPagesToCanvas(out.pages);
  out.document.slideSizePt = { width: fit.widthPt, height: fit.heightPt };
  out.document.pageSizePolicy = fit.fittedPages ? "fit-to-dominant-page" : "source";
  out.document.fittedPages = fit.fittedPages;
  out.identity = captureIdentity(out);
  return out;
  } finally {
    release(doc);
  }
}

/**
 * The document's visual identity, measured from the document itself.
 *
 * This is the baseline the conversion must not move. "Keep the identity 100%"
 * only means something if the identity is a recorded fact rather than a memory
 * of what the deck looked like, so it is captured at import — before any edit —
 * and the doctor compares the live model against it.
 *
 * Measured across the 6-deck corpus: 4 text colours, 6 shape fills, 3 stroke
 * colours, 1 background, 4 real faces. A brand that tight makes drift obvious,
 * which is the point: anything outside these sets was introduced by us or by an
 * edit, never by the designer.
 *
 * Ordered by INK, not by object count — one full-bleed panel says more about a
 * palette than forty hairlines — but NOTHING is dropped for being rare. A
 * minimum-share floor was tried and removed: these values come from the model,
 * not from pixels, so every one of them is an authored decision rather than
 * antialiasing noise, and a 0.1% floor deleted "Segoe UI Emoji" (46 characters
 * across the corpus) from the identity — after which the doctor reported the
 * source's own emoji as off-brand drift, six times. An identity that excludes
 * part of the source cannot measure whether the source survived.
 */
export function captureIdentity(model) {
  const tally = (entries) => {
    const m = new Map();
    for (const [k, v] of entries) if (k) m.set(k, (m.get(k) ?? 0) + v);
    const total = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, weight]) => ({ value, share: +(weight / total).toFixed(4) }));
  };

  const textInk = [], fillInk = [], strokeInk = [], faceInk = [], bgCount = [];
  for (const page of model.pages) {
    bgCount.push([page.background ?? "FFFFFF", 1]);
    for (const o of page.objects) {
      if (o.type === "text") {
        for (const r of o.runs ?? []) {
          // Ink ~ characters x size: a 44pt heading outweighs a 9pt caption.
          const ink = r.text.replace(/\s/g, "").length * (r.fontSizePt || 12);
          textInk.push([r.color, ink]);
          // A face is (family, bold, italic), not a display string: "Lyon Arabic
          // Text LF Bold" with no bold attribute and "Lyon Arabic Text LF" +
          // bold would flatten to the same label and are NOT the same request.
          faceInk.push([faceId(r), ink]);
        }
      } else if (o.type === "shape") {
        const area = Math.max(o.bbox.w, 0.1) * Math.max(o.bbox.h, 0.1);
        if (o.fill) fillInk.push([o.fill, area]);
        if (o.stroke) strokeInk.push([o.stroke, area]);
      }
    }
  }

  const colors = tally([...textInk, ...fillInk, ...strokeInk, ...bgCount.map(([c]) => [c, 0.0001])]);
  return {
    capturedFrom: "source",
    textColors: tally(textInk),
    fills: tally(fillInk),
    strokes: tally(strokeInk),
    backgrounds: tally(bgCount),
    // Most-used first, so a repair can ask for "the source's heading face"
    // without recomputing anything from the page it is repairing.
    faces: tally(faceInk).map(({ value, share }) => ({ ...parseFaceId(value), id: value, share })),
    /** Every colour the source uses anywhere — the palette an edit must stay inside. */
    palette: colors.map((c) => c.value),
  };
}

/**
 * Identity of a typeface REQUEST, as a single comparable key.
 * Shared with web/doctor.js, which must split faces on the same axis or the
 * identity check compares two different things.
 */
const FACE_SEP = "\u001f";   // unit separator: cannot occur in a font family name

export const faceId = (run) =>
  [run.fontFamily, run.bold ? 1 : 0, run.italic ? 1 : 0].join(FACE_SEP);

export function parseFaceId(id) {
  const [family, bold, italic] = String(id).split(FACE_SEP);
  return {
    family,
    bold: bold === "1",
    italic: italic === "1",
    label: `${family}${bold === "1" ? " Bold" : ""}${italic === "1" ? " Italic" : ""}`,
  };
}
