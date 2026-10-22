/**
 * Normalized slide model -> editable deck HTML.
 *
 * This is the join between the two apps. The PDF engine emits the normalized
 * model (`src/model/normalize.js`); the Electron editor eats a full HTML
 * document loaded into an iframe via `srcdoc`. This file turns the first into
 * the second, so a reconstructed PDF becomes editable by the SAME editor, and
 * exportable by the SAME PDF/PPTX paths, as a hand-written HTML lecture.
 *
 * The geometry and per-object styling are ported from the pdf=ppt web editor's
 * `renderObject` (engine/web/editor.js) rather than re-derived — that version is
 * the one measured against real decks. Three deliberate differences:
 *
 *   1. Images are inlined as `data:` URLs. The editor loads the deck through
 *      `srcdoc`, which has no origin and therefore no server to fetch from, and
 *      the PDF export path re-renders that same HTML in a throwaway window.
 *      A linked image is a blank box in both.
 *   2. No selection grips. The Electron editor draws its own selection UI.
 *   3. Page background honours `sourceFit` (see `background` below).
 *
 * Coordinates are PDF points rendered 1pt -> 1px, matching the model and the
 * web editor. The editor's own zoom handles display scaling.
 */
import * as fs from "node:fs";
import { imageFile, mimeForRef } from "./src/model/images.js";

/**
 * Families that ship with Windows + Office, as the tail of every font stack.
 *
 * SINGLE quotes, deliberately. These land inside `style="..."`, so a double
 * quote here closes the attribute and silently discards every declaration after
 * it — which is not a cosmetic bug: it drops font-size and colour too, so the
 * whole deck renders at the browser's default 16px and every measured bbox
 * overflows. Measured before the fix: 281 of 281 runs painted in Segoe UI 16px.
 */
const FALLBACK_STACK = "'Segoe UI', 'Times New Roman', sans-serif";

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** `{a:"1px", b:null}` -> `a:1px;` — null/undefined entries are dropped. */
const css = (decls) =>
  Object.entries(decls)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}:${v}`)
    .join(";");

const px = (n) => `${+(+n).toFixed(2)}px`;

/**
 * An image ref resolved to a `data:` URL, or null when the bytes are gone.
 *
 * Returning null rather than an empty `src` matters: the caller renders a
 * loud placeholder for a missing image, because a silent blank box on a slide
 * is indistinguishable from a white rectangle the source actually drew.
 */
function dataUrl(ref) {
  const file = imageFile(ref);
  if (!file) return null;
  try {
    return `data:${mimeForRef(ref)};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function renderRuns(runs) {
  return (runs ?? [])
    .map((run) => {
      const style = css({
        // Single-quoted, and any single quote in the family name stripped —
        // see FALLBACK_STACK.
        "font-family": `'${String(run.fontFamily ?? "").replace(/'/g, "")}', ${FALLBACK_STACK}`,
        "font-size": px(run.fontSizePt),
        color: run.color ? `#${run.color}` : null,
        "font-weight": run.bold ? "700" : null,
        "font-style": run.italic ? "italic" : null,
      });
      // srcW is the width this run occupied in the SOURCE page. Carrying it
      // into the DOM makes "is the browser laying this out at the size the PDF
      // drew it" a measurement rather than an opinion — the fidelity check the
      // whole reconstruction rests on.
      const srcW = run.srcW != null ? ` data-srcw="${+run.srcW.toFixed(2)}"` : "";
      return `<span${srcW} style="${style}">${escapeHtml(run.text)}</span>`;
    })
    .join("");
}

function renderText(obj) {
  const base = {
    left: px(obj.bbox.x),
    top: px(obj.bbox.y),
    width: px(obj.bbox.w),
    height: px(obj.bbox.h),
    "z-index": obj.zIndex,
    direction: obj.paragraphDirection,
    "text-align": obj.alignment,
  };

  // A text object recovered from table cells carries its own per-cell geometry.
  // Laying those out individually is what keeps a table looking like a table
  // instead of one run-on line across the row.
  const useSegments = obj.tableSegments?.length && obj.text === obj.tableSourceText;
  if (useSegments) {
    const inners = obj.tableSegments
      .map((seg) => {
        const style = css({
          position: "absolute",
          left: px(seg.bbox.x - obj.bbox.x),
          top: px(seg.bbox.y - obj.bbox.y),
          width: px(seg.bbox.w),
          height: px(seg.bbox.h),
          display: "flex",
          "align-items": "center",
          "justify-content":
            seg.alignment === "right" ? "flex-end" : seg.alignment === "left" ? "flex-start" : "center",
          direction: seg.paragraphDirection,
          "text-align": seg.alignment,
          overflow: "hidden",
        });
        return `<div style="${style}">${renderRuns(seg.runs)}</div>`;
      })
      .join("");
    return `<div class="obj text" data-id="${obj.id}" data-align="${obj.alignment}" style="${css({ ...base, display: "block" })}">${inners}</div>`;
  }

  const inner = `<div style="${css({ width: "100%", direction: obj.paragraphDirection, "text-align": obj.alignment })}">${renderRuns(obj.runs)}</div>`;
  return `<div class="obj text" data-id="${obj.id}" data-align="${obj.alignment}" style="${css(base)}">${inner}</div>`;
}

function renderShape(obj) {
  const style = css({
    left: px(obj.bbox.x),
    top: px(obj.bbox.y),
    width: px(obj.bbox.w),
    height: px(obj.bbox.h),
    "z-index": obj.zIndex,
    background: obj.fill ? `#${obj.fill}` : null,
    border: obj.stroke ? `${Math.max(obj.strokeWidth, 0.4)}px ${obj.dashed ? "dashed" : "solid"} #${obj.stroke}` : null,
    "border-radius":
      obj.shapeType === "ellipse" ? "50%" : obj.shapeType === "roundRect" ? px(obj.cornerRadiusPt || 3) : null,
    opacity: obj.opacity != null && obj.opacity < 1 ? obj.opacity : null,
  });
  return `<div class="obj shape" data-id="${obj.id}" style="${style}"></div>`;
}

function renderImage(obj) {
  const geom = {
    left: px(obj.bbox.x),
    top: px(obj.bbox.y),
    width: px(obj.bbox.w),
    height: px(obj.bbox.h),
    "z-index": obj.zIndex,
    opacity: obj.opacity != null && obj.opacity < 1 ? obj.opacity : null,
  };

  const src = obj.ref ? dataUrl(obj.ref) : null;
  if (!src) {
    // Say it loudly. See dataUrl() above.
    const style = css({
      ...geom,
      background: "repeating-linear-gradient(45deg,#fdeaea 0 6px,#f8d4d4 6px 12px)",
      border: "1px dashed #c66",
    });
    const why = obj.decodeError ? `image could not be decoded — ${obj.decodeError}` : "image has no pixels";
    return `<div class="obj image" data-id="${obj.id}" title="${escapeHtml(why)}" style="${style}"></div>`;
  }
  return `<img class="obj image" data-id="${obj.id}" alt="" src="${src}" style="${css({ ...geom, "object-fit": "fill" })}">`;
}

function renderObject(obj) {
  // A soft-mask definition is the alpha channel of the thing painted next, not
  // a picture. Drawing one paints the mask instead of its subject.
  if (obj.type === "image" && obj.isMask) return "";
  if (obj.type === "text") return renderText(obj);
  if (obj.type === "shape") return renderShape(obj);
  if (obj.type === "image") return renderImage(obj);
  return "";
}

function renderPage(page, index) {
  const slideStyle = css({
    width: px(page.widthPt),
    height: px(page.heightPt),
    // A fitted page does NOT get an edge-to-edge fill: its content lives inside
    // the fitted rectangle, so a full-bleed background would read as a
    // full-bleed slide with the content squeezed into the middle.
    background: page.background && !page.sourceFit?.fitted ? `#${page.background}` : "#fff",
  });

  let backdrop = "";
  if (page.background && page.sourceFit?.fitted) {
    const f = page.sourceFit;
    backdrop = `<div class="obj" style="${css({
      left: px(f.x),
      top: px(f.y),
      width: px(page.sourceSizePt.widthPt * f.scale),
      height: px(page.sourceSizePt.heightPt * f.scale),
      background: `#${page.background}`,
      "z-index": 0,
    })}"></div>`;
  }

  // Objects arrive in true paint order, so document order reproduces z-order.
  const objects = page.objects.map(renderObject).join("\n");
  return `<div class="slide" data-page="${index}" style="${slideStyle}">\n${backdrop}${objects}\n</div>`;
}

const DECK_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f4f4f6;font-family:${FALLBACK_STACK}}
.slide{position:relative;margin:40px auto;background:#fff;
  box-shadow:0 6px 24px rgba(0,0,0,.14);overflow:hidden}
.obj{position:absolute}
.obj.text{display:flex;align-items:center;white-space:pre;line-height:1.15}
.obj.text[data-align="right"]{justify-content:flex-end}
.obj.text[data-align="center"]{justify-content:center}
img.obj{display:block}
`.trim();

/**
 * Full editable deck document for one reconstructed PDF.
 *
 * `dir` comes from the reconstruction rather than from a guess: a deck whose
 * text is mostly RTL gets `dir="rtl"`, which is what makes newly typed text in
 * the editor inherit the right direction.
 */
export function modelToDeckHtml(model, { title } = {}) {
  const texts = model.pages.flatMap((p) => p.objects.filter((o) => o.type === "text"));
  const rtl = texts.filter((o) => o.paragraphDirection === "rtl").length;
  const dir = rtl > texts.length / 2 ? "rtl" : "ltr";
  const name = title || "Reconstructed PDF";

  const slides = model.pages.map(renderPage).join("\n");
  return (
    `<!doctype html><html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(name)}</title>` +
    `<style>${DECK_CSS}</style></head><body>\n${slides}\n</body></html>`
  );
}
