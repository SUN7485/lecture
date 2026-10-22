/**
 * Normalized model -> PPTX.
 *
 * Fidelity rules that matter for Arabic, and why:
 *  - one logical paragraph = ONE textbox, so PowerPoint keeps RTL paragraph
 *    behaviour instead of us faking it with one box per visual line
 *  - autofit OFF, so PowerPoint never silently rescales the source type
 *  - insets ZERO, so the box we position is the box the text sits in
 *  - slide size taken from the page, never forced to 16:9
 */
import PptxGenJS from "pptxgenjs";
import { imageFile } from "../model/images.js";
import { paragraphDirection } from "../model/direction.js";

const PT_PER_INCH = 72;
const pt = (v) => v / PT_PER_INCH;

/**
 * Vertical nudge. A block's box is the union of its glyph quads, which includes
 * ascender/descender padding that PowerPoint adds again from line height. Half
 * the leading brings the rendered baseline back onto the source baseline.
 */
const BASELINE_TRIM = 0.18;

/** PowerPoint preset geometries we map onto directly. */
const PRESET = { rect: "rect", roundRect: "roundRect", ellipse: "ellipse", line: "line" };

/** Emit one model shape as a native PowerPoint shape. */
function addShape(slide, obj, stats) {
  // A bbox is not a representation of an unsupported path. Complex paths are
  // normally converted to transparent images upstream; if one failed, omit the
  // false rectangle and let the coverage warning name the loss.
  const preset = PRESET[obj.shapeType];
  if (!preset || obj.reconstructionStrategy === "unsupported") {
    stats.shapesUnsupported++;
    return;
  }
  const transparency = obj.opacity != null && obj.opacity < 1 ? Math.round((1 - obj.opacity) * 100) : 0;

  const opts = {
    x: pt(obj.bbox.x),
    y: pt(obj.bbox.y),
    w: pt(Math.max(obj.bbox.w, 0.01)),
    h: pt(Math.max(obj.bbox.h, 0.01)),
    fill: obj.fill ? { color: obj.fill, transparency } : { type: "none" },
    line: obj.stroke
      ? { color: obj.stroke, width: Math.max(obj.strokeWidth, 0.25),
          dashType: obj.dashed ? "dash" : "solid", transparency }
      : { type: "none" },
  };

  // An ascending line. A bbox alone cannot say which diagonal it is, and the
  // preset always draws the descending one — see risesLeftToRight.
  if (obj.flipV) opts.flipV = true;

  // rectRadius is in INCHES; pptxgenjs converts it to the DrawingML adj value.
  if (preset === "roundRect" && obj.cornerRadiusPt > 0) opts.rectRadius = pt(obj.cornerRadiusPt);

  slide.addShape(preset, opts);
  stats.shapes++;
}

/**
 * Emit one model image as a native PowerPoint picture.
 *
 * Placement is the bbox, which is the picture's frame — exact rather than
 * convenient, because every image transform measured here is axis-aligned with
 * positive scale (no rotation, skew or flip), so the rectangle the unit square
 * maps to is the placement.
 *
 * It is not always the whole story. A page may place a large picture and clip
 * it to a small frame, which the corpus never does and every other producer
 * does constantly; those carry `clippedFrom` and are cropped below.
 */
function addImage(slide, obj, stats) {
  // An image the source collapsed to no area paints nothing in the source
  // either; asking PowerPoint for a zero-height picture would be inventing ink.
  if (obj.reconstructionStrategy === "degenerate") { stats.imagesDegenerate++; return; }

  const file = imageFile(obj.ref);
  // Not something to paper over: this is the exact silent loss the project
  // exists to prevent, so it is counted here and failed by the coverage ledger.
  if (!file) { stats.imagesDropped++; return; }

  // A picture the page clipped to a frame. PowerPoint crops with `srcRect`,
  // whose percentages pptxgenjs computes from the DECLARED size against the
  // `sizing` box — so the declared w/h must be the full placement and the crop
  // box the visible part, after which the drawn frame becomes the crop box at
  // this object's own x/y. The image bytes are untouched: two pictures cropped
  // differently out of one source still share a single media part.
  const placed = obj.clippedFrom ?? obj.bbox;

  slide.addImage({
    path: file,
    x: pt(obj.bbox.x),
    y: pt(obj.bbox.y),
    w: pt(placed.w),
    h: pt(placed.h),
    ...(obj.clippedFrom
      ? { sizing: { type: "crop",
                    x: pt(obj.bbox.x - placed.x), y: pt(obj.bbox.y - placed.y),
                    w: pt(obj.bbox.w), h: pt(obj.bbox.h) } }
      : {}),
    ...(obj.opacity != null && obj.opacity < 1
      ? { transparency: Math.round((1 - obj.opacity) * 100) }
      : {}),
  });
  stats.images++;
}

/**
 * Split a text block where the source drew a box around PART of the line.
 *
 * A line is one textbox, so its INTERNAL layout belongs to PowerPoint, not to
 * the source: PowerPoint re-shapes the text and the width it produces is not the
 * width the PDF drew. With `wrap:false` and right alignment the difference
 * accumulates leftward, so a fragment in the middle of the line slides sideways.
 * That is invisible until the source drew a decorative box around exactly that
 * fragment — an inline `=STDEV.P()` chip — because the box is a shape pinned to
 * absolute coordinates and cannot follow. Measured on Chp1-Lec4-2 slide 8: the
 * boxes land within 0.5pt of the source, the token inside drifts 31.6pt and ends
 * up outside its own box.
 *
 * The honest reading is that such a line is not one positioned unit but several
 * — the chips are separate boxes in the source's own layout — so each group of
 * runs is emitted at the coordinates its glyphs actually occupied. A group that
 * sits inside a box is centred in that box, so any residual width difference is
 * split evenly instead of pushing the text out one side.
 *
 * Blocks with no enclosing box (the overwhelming majority) come back as a single
 * segment and are emitted exactly as before.
 *
 * @returns {Array<{runs:Array, x:number, w:number, align:string}>}
 */
/** Share of a line's height a shape must cover before it counts as its chip. */
const MIN_BOX_COVER = 0.6;
/** How far a chip's border may sit outside the text it wraps (pt). */
const CHIP_PAD = 8;

/**
 * Characters XML 1.0 cannot represent AT ALL — not even escaped.
 *
 * MEASURED. A 288-page pdfTeX dissertation produced a package PowerPoint refused
 * with "The file or directory is corrupted and unreadable" (HRESULT 0x80070570).
 * Bisected to a single page, page 49, whose slide XML carried **six U+001A
 * (SUBSTITUTE)** characters inside `<a:t>`, emitted by `LINE10` — a Computer
 * Modern rule-drawing font whose ToUnicode maps glyphs onto C0 control codes,
 * which is that font's way of saying "this glyph has no Unicode".
 *
 * `&#26;` is NOT a fix: XML 1.0 forbids these codepoints in the document at all,
 * escaped or not, so every conforming parser must reject the file. They can only
 * be removed. Dropping is also the honest reading — U+001A means "no character
 * here", so nothing is lost that was ever text.
 *
 * The corpus cannot show this: Chrome's Skia never emits a control codepoint, so
 * 28 decks of evidence say the writer is safe when it is one glyph away from
 * producing a file nobody can open.
 *
 * Also removed: lone surrogates, which are equally fatal and equally unescapable.
 * TAB, LF and CR are legal and are kept.
 */
const XML_ILLEGAL = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]" + "|" +
  "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])" + "|" +
  "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]", "g");
export const xmlSafe = (s) => String(s ?? "").replace(XML_ILLEGAL, "");

export function segmentByFieldBoxes(obj, shapes) {
  const runs = obj.runs;
  if (!runs?.length || runs.some((r) => r.srcX == null)) return null;

  // Boxes that enclose a proper horizontal sub-range of this line.
  const blockX1 = obj.bbox.x + obj.bbox.w;
  const boxes = shapes.filter((s) => {
    const vOverlap =
      Math.min(obj.bbox.y + obj.bbox.h, s.bbox.y + s.bbox.h) - Math.max(obj.bbox.y, s.bbox.y);
    // A chip ENCLOSES its text; a 2pt overlap only proves the two are adjacent.
    // Measured on `Chp1-Lec3-2(New)` slide 9: the table header cells begin 2.09pt
    // inside the bottom of the line above them, which is 9.8% of that line's
    // height and enough to pass a 2pt test. Three of the four runs were then
    // re-anchored to header cells and CENTRED in them, and
    // `مايكروسوفت إكسل (Microsoft Excel 365)` was drawn 14pt on top of the words
    // before it. A box that does not cover most of the line was never a box
    // around it.
    if (vOverlap < obj.bbox.h * MIN_BOX_COVER) return false;
    // A CHIP IS DRAWN WITH PADDING, so it starts to the LEFT of the text it wraps
    // and ends to the right of it. Requiring the box to begin strictly inside the
    // line's own span therefore excludes exactly the chip at either END of the
    // line — measured on `Chp1-Lec4-2` p6, where the box around `=MODE.SNGL()`
    // starts 5.8pt left of the line's leftmost glyph. That formula then fell into
    // the right-aligned segment with the Arabic, was drawn at the right end of the
    // line ON TOP of `=AVERAGE()`, and left its own chip empty.
    //
    // What the test is actually for is "a box around PART of this line, not all of
    // it", so that is what it now asks: narrower than the line, and within it to
    // within a chip's padding.
    return s.bbox.w < obj.bbox.w - 1 &&
      s.bbox.x > obj.bbox.x - CHIP_PAD && s.bbox.x + s.bbox.w < blockX1 + CHIP_PAD;
  });
  if (!boxes.length) return null;

  // A run belongs to the box its CENTRE falls in — an edge test would claim a
  // neighbouring run whose glyph merely touches the border.
  const owner = runs.map((r) => {
    const c = r.srcX + r.srcW / 2;
    return boxes.findIndex((b) => c > b.bbox.x && c < b.bbox.x + b.bbox.w);
  });
  if (!owner.some((o) => o >= 0) || !owner.some((o) => o < 0)) return null;

  const segments = [];
  for (let i = 0; i < runs.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.box === owner[i]) last.runs.push(runs[i]);
    else segments.push({ box: owner[i], runs: [runs[i]] });
  }

  // A CHIP HOLDS ONE PIECE OF TEXT. The grouping above is by CONSECUTIVE runs, so
  // when the runs owning a box are not consecutive it emits two segments claiming
  // the SAME box — and both then render at that box's coordinates, one drawn
  // exactly on top of the other. Measured on the 118-page Unit Five deck p77:
  // `verify-segments` reported two pairs at identical spans, 237.8..268.6 and
  // 280.3..306.2, each printed twice.
  //
  // What put a run in the wrong box there is a separate, deeper defect: run
  // `VAM*` carries a source extent of 123.59pt for four characters, because bidi
  // placed its neutral `*` beside the Arabic 100pt away from its own letters and
  // `blockRuns` takes a run's extent as min/max over its glyphs. Its CENTRE
  // therefore lands in a chip its text never touches. That defect is priced in
  // KNOWN_ISSUES (41 runs over 28 decks, 0 of them visible there) and is NOT
  // fixed here — changing run extents moves geometry on 29 corpus blocks and
  // needs its own gate.
  //
  // This guard is the consumer refusing a contradiction it can see locally.
  // Falling back to `null` puts the line on the ordinary single-box path, which
  // cannot overlap itself: a worse ANCHORING in exchange for a correct RENDER.
  const claimed = segments.filter((s) => s.box >= 0).map((s) => s.box);
  if (new Set(claimed).size !== claimed.length) return null;

  return segments.map((seg) => {
    if (seg.box >= 0) {
      const b = boxes[seg.box].bbox;
      return { runs: seg.runs, x: b.x, w: b.w, align: "center" };
    }
    const x = Math.min(...seg.runs.map((r) => r.srcX));
    const x1 = Math.max(...seg.runs.map((r) => r.srcX + r.srcW));
    return { runs: seg.runs, x, w: Math.max(x1 - x, 0.5), align: obj.alignment };
  });
}

export async function writePptx(model, outPath, { pageDelivery = null } = {}) {
  const pptx = new PptxGenJS();
  const first = model.pages[0];

  pptx.defineLayout({ name: "source", width: pt(first.widthPt), height: pt(first.heightPt) });
  pptx.layout = "source";
  pptx.author = "Lecture Reconstruction Studio";
  pptx.title = model.document.sourceFile.split(/[\\/]/).pop();

  const stats = { slides: 0, textboxes: 0, runs: 0, shapes: 0, shapesUnsupported: 0, splitBlocks: 0,
    images: 0, imagesDropped: 0, imagesDegenerate: 0, rasterSlides: 0 };

  for (const page of model.pages) {
    const slide = pptx.addSlide();
    stats.slides++;
    const delivered = pageDelivery?.get?.(page.index) ?? pageDelivery?.[page.index];
    if (delivered?.imagePath) {
      // A fidelity fallback is exactly one visible full-slide image. No source
      // text or hidden OCR layer is emitted: the report, not invisible content,
      // is where the loss of editability is declared.
      slide.addImage({
        path: delivered.imagePath,
        x: 0,
        y: 0,
        w: pt(page.widthPt),
        h: pt(page.heightPt),
      });
      stats.images++;
      stats.rasterSlides++;
      continue;
    }
    // A page fill covering the whole PAGE is the slide background — but only on
    // a page that covers the whole slide. When the source carries several page
    // geometries the odd pages are scaled and centred, and `slide.background`
    // floods the side bands too: the page's own colour runs edge to edge while
    // every other object on it stays inside the fitted rectangle, which reads as
    // a full-bleed slide with the content squeezed into the middle. Measured on
    // a 118-page merged lecture: pages 64 and 79 (the two section covers, both
    // full-bleed) scored ink IoU 0.67-0.68 with 48% EXTRA ink and were the two
    // worst pages in the deck, while the other 29 fitted pages averaged 0.96.
    //
    // On a fitted page the fill is therefore drawn where the page actually is.
    // It is added before the object loop, so it stays at the back.
    if (page.background) {
      const f = page.sourceFit;
      if (f?.fitted) {
        slide.addShape("rect", {
          x: pt(f.x), y: pt(f.y),
          w: pt(page.sourceSizePt.widthPt * f.scale),
          h: pt(page.sourceSizePt.heightPt * f.scale),
          fill: { color: page.background }, line: { type: "none" },
        });
      } else {
        slide.background = { color: page.background };
      }
    }

    const shapesOnPage = page.objects.filter((o) => o.type === "shape");

    // Objects arrive in true paint order; pptxgenjs emits in call order, so
    // iterating the list as-is reproduces the source z-order exactly. Measured:
    // vectors and text interleave on every page, so shapes-then-text is wrong.
    for (const obj of page.objects) {
      if (obj.type === "shape") { addShape(slide, obj, stats); continue; }
      if (obj.type === "image") { addImage(slide, obj, stats); continue; }
      if (obj.type !== "text" || !obj.text) continue;

      const useTableSegments = obj.tableSegments?.length && obj.text === obj.tableSourceText;
      const textObjects = useTableSegments
        ? obj.tableSegments.map((segment) => ({ ...obj, ...segment, tableSegments: null }))
        : [obj];

      for (const textObj of textObjects) {
        const runs = textObj.runs.length
          ? textObj.runs
          : [{ text: textObj.text, fontSizePt: 12, color: "000000" }];
        const maxSize = Math.max(...runs.map((r) => r.fontSizePt));
        const lead = maxSize * BASELINE_TRIM;
        // The DELIVERY answer, computed once in the model from the finished
        // text (src/model/direction.js). Never `sourceStreamDirection`, which
        // answers a different question and is the defect this separation exists
        // to prevent — see KNOWN_ISSUES 2026-08-20.
        const isRtl = textObj.paragraphDirection === "rtl";

        // Cell-sized units are already the final segmentation. Running the
        // field-box splitter over table rules is the exact false positive that
        // once moved header runs into neighbouring cells.
        const segments = useTableSegments
          ? [{ runs, x: textObj.bbox.x, w: textObj.bbox.w, align: textObj.alignment }]
          : (segmentByFieldBoxes(textObj, shapesOnPage) ??
            [{ runs, x: textObj.bbox.x, w: textObj.bbox.w, align: textObj.alignment }]);
        if (!useTableSegments && segments.length > 1) stats.splitBlocks++;

        for (const seg of segments) {
        // A FIELD-BOX SEGMENT IS A PARAGRAPH THE MODEL NEVER SAW.
        //
        // `segmentByFieldBoxes` cuts a line into pieces at write time, so those
        // pieces have no `paragraphDirection` of their own and would inherit the
        // whole line's — which is how a Latin-only slice of an Arabic sentence
        // (`=SUMIF(range ; criteria ; sum_range)`, `$F$2`, a lone `;`) shipped
        // `rtl="1"`. They are the only paragraphs narrowed here; everything else
        // uses the answer the model already computed from its own text, so a
        // direction the user set in the editor is not silently overridden.
        //
        // MEASURED over 30 decks / 14040 paragraphs before the narrowing: 102
        // paragraphs carried rtl="1" with no right-to-left character in them.
        const segRtl = segments.length > 1
          ? paragraphDirection(seg.runs.map((r) => r.text).join(""), textObj.paragraphDirection) === "rtl"
          : isRtl;

        // pptxgenjs reads rtlMode off the FIRST RUN's options when text is passed
        // as an array ("its propagated up to each text:options, so just check the
        // 1st one"), so a top-level rtlMode never reaches <a:pPr> and every
        // Arabic paragraph ships without rtl="1". Set it per run.
        const textParts = seg.runs.map((r) => ({
          text: xmlSafe(r.text),
          options: {
            fontFace: r.fontFamily,
            fontSize: r.fontSizePt,
            color: r.color,
            bold: r.bold,
            italic: r.italic,
            rtlMode: segRtl,
            // Sub/superscript, at the offset the SOURCE used. pptxgenjs writes
            // `baseline` as its value x 50 into OOXML's 1/1000-of-a-percent, and
            // `baseline` overrides its own subscript/superscript presets — which
            // is what we want, because those also RESIZE and the run already
            // carries the source's smaller size. See tagScriptLevels.
            ...(r.lift ? { baseline: Math.round(r.lift * 20) } : {}),
            align: seg.align,
            // `lang` drives PowerPoint's script detection; without an Arabic tag
            // it can apply Latin metrics to Arabic runs.
            lang: r.script === "Arab" ? "ar-SA" : "en-US",
          },
        }));

          // A rotated line is stored as its axis-aligned INK extent, but
          // PowerPoint rotates a box about its own centre — so the box handed
          // over must be the UNROTATED one: the text's length along its own
          // baseline becomes the width, its line height the height, both
          // centred on the same point. Passing the ink box straight through
          // would rotate a tall narrow box into a wide flat one and put the
          // caption somewhere else entirely.
          const rot = textObj.rotation ?? 0;
          const box = rot
            ? (() => {
                const cx = seg.x + seg.w / 2;
                const cy = textObj.bbox.y + textObj.bbox.h / 2;
                const w = textObj.bbox.h + lead, h = seg.w;
                return { x: cx - w / 2, y: cy - h / 2, w, h };
              })()
            : { x: seg.x, y: textObj.bbox.y - lead / 2, w: seg.w, h: textObj.bbox.h + lead };

          slide.addText(textParts, {
            ...(rot ? { rotate: rot } : {}),
            x: pt(box.x),
            y: pt(box.y),
            w: pt(box.w),
            h: pt(box.h),
            align: seg.align,
            valign: "middle",
            rtlMode: segRtl,
            autoFit: false,
            shrinkText: false,
            wrap: false,        // line breaks come from the source, not from PowerPoint
            inset: 0,
            margin: 0,
            lineSpacingMultiple: 1,
            isTextBox: true,
          });

          stats.textboxes++;
          stats.runs += seg.runs.length;
        }
      }
    }
  }

  await pptx.writeFile({ fileName: outPath });
  return stats;
}
