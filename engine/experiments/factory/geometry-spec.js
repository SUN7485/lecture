/**
 * GEOMETRY GROUND TRUTH — where the page puts a thing, authored.
 *
 * WHY THIS EXISTS, and it is the whole argument for building geometry before
 * tables. `«78»` on `Chp1-Lec1-3(New)` p17 extracted **verbatim** — every
 * character correct, every text gate green — and was delivered **125pt** from
 * where the page paints it, because the writer centred it in a cell the source
 * right-anchors. No text metric could see that, and neither could whole-page ink
 * IoU, which said the page was fine because the ink was still on it.
 *
 *   THE FIRST GEOMETRY INVARIANT
 *   Correct content at the wrong anchor is a FAILURE.
 *
 * So this measures placement as its own axis, and it terminates at the DELIVERED
 * package rather than at the model — the model had `«78»` right.
 *
 * WHAT IS AUTHORED, and what is not. The BOX and the ANCHOR are written here, so
 * the question "did it land where it was put" has an answer that no extraction
 * produced. The INK extent is not authored: how wide a string paints is the
 * font's business, so it is read from the source PDF's own glyph quads and used
 * only for the deltas that need it. Nothing is compared against a number this
 * project computed twice.
 *
 * A cell is a RECTANGLE before it is a table, so there are no tables here. Two
 * adjacent boxes with a shared edge is the geometry a table is made of, and it
 * is the shape `«78»` failed at.
 */

/**
 * @typedef {{
 *   id: string, family: string, text: string, dir: "rtl"|"ltr",
 *   x: number, y: number, w: number, h: number,
 *   anchor: "left"|"right"|"center", fontSize: number, rotation?: number
 * }} GeometryItem
 */

const A = "الجودة";          // 6 Arabic letters, ~1 word
const A_LONG = "قيمة المتغير في الحل الأمثل";
const E = "Value";
const E_LONG = "Reduced Cost and Shadow Price";

let n = 0;
const item = (family, o) => ({ family, id: `${family}-${++n}`, rotation: 0, ...o });

/** @type {GeometryItem[]} */
export const GEOMETRY = [
  // --- THE `«78»` SHAPE: short text in a wide box, at each anchor ------------
  // The whole point. Same string, same box, three anchors — a converter that
  // ignores the anchor gets one of the three right by luck and the other two
  // wrong by up to the box's width.
  item("anchor", { text: "«78»", dir: "rtl", x: 60, y: 40, w: 300, h: 22, anchor: "right", fontSize: 12 }),
  item("anchor", { text: "«78»", dir: "rtl", x: 60, y: 70, w: 300, h: 22, anchor: "left", fontSize: 12 }),
  item("anchor", { text: "«78»", dir: "rtl", x: 60, y: 100, w: 300, h: 22, anchor: "center", fontSize: 12 }),
  item("anchor", { text: E,      dir: "ltr", x: 60, y: 130, w: 300, h: 22, anchor: "right", fontSize: 12 }),
  item("anchor", { text: E,      dir: "ltr", x: 60, y: 160, w: 300, h: 22, anchor: "left", fontSize: 12 }),

  // --- ONE CHARACTER, where every error is a large share of the ink ---------
  item("single", { text: "٥", dir: "rtl", x: 420, y: 40, w: 120, h: 22, anchor: "right", fontSize: 12 }),
  item("single", { text: "X", dir: "ltr", x: 420, y: 70, w: 120, h: 22, anchor: "left", fontSize: 12 }),

  // --- TIGHT box: the text fills it, so drift has nowhere to hide -----------
  item("tight", { text: A, dir: "rtl", x: 420, y: 100, w: 44, h: 22, anchor: "right", fontSize: 12 }),
  item("tight", { text: E, dir: "ltr", x: 420, y: 130, w: 34, h: 22, anchor: "left", fontSize: 12 }),

  // --- TWO ADJACENT BOXES sharing an edge — a table before it is a table ----
  item("adjacent", { text: A, dir: "rtl", x: 60,  y: 200, w: 150, h: 22, anchor: "right", fontSize: 12 }),
  item("adjacent", { text: E, dir: "ltr", x: 210, y: 200, w: 150, h: 22, anchor: "left",  fontSize: 12 }),
  item("adjacent", { text: "٧", dir: "rtl", x: 360, y: 200, w: 60, h: 22, anchor: "center", fontSize: 12 }),

  // --- SAME string and font, different anchor, side by side -----------------
  item("sameword", { text: A, dir: "rtl", x: 60,  y: 240, w: 200, h: 22, anchor: "right", fontSize: 12 }),
  item("sameword", { text: A, dir: "rtl", x: 280, y: 240, w: 200, h: 22, anchor: "left",  fontSize: 12 }),

  // --- MIXED direction in one box -------------------------------------------
  item("mixed", { text: "تحسين (Ergonomics) العمل", dir: "rtl", x: 60, y: 280, w: 340, h: 22, anchor: "right", fontSize: 12 }),

  // --- LONG text, both scripts ----------------------------------------------
  item("long", { text: A_LONG, dir: "rtl", x: 60,  y: 320, w: 340, h: 22, anchor: "right", fontSize: 12 }),
  item("long", { text: E_LONG, dir: "ltr", x: 420, y: 320, w: 240, h: 22, anchor: "left",  fontSize: 12 }),

  // --- FONT SIZE, because a delta must be read against the em ---------------
  item("size", { text: A, dir: "rtl", x: 60,  y: 360, w: 200, h: 14, anchor: "right", fontSize: 7 }),
  item("size", { text: A, dir: "rtl", x: 280, y: 356, w: 200, h: 34, anchor: "right", fontSize: 22 }),

  // --- PAGE EDGE: nothing to clamp against on one side ----------------------
  item("edge", { text: A, dir: "rtl", x: 2,   y: 400, w: 120, h: 22, anchor: "left",  fontSize: 12 }),
  item("edge", { text: E, dir: "ltr", x: 590, y: 400, w: 120, h: 22, anchor: "right", fontSize: 12 }),

  // --- ROTATION -------------------------------------------------------------
  item("rotated", { text: E, dir: "ltr", x: 470, y: 180, w: 120, h: 22, anchor: "left", fontSize: 12, rotation: -90 }),
  item("rotated", { text: E, dir: "ltr", x: 560, y: 180, w: 120, h: 22, anchor: "left", fontSize: 12, rotation: -45 }),
];

export const GEOMETRY_FAMILIES = [...new Set(GEOMETRY.map((g) => g.family))];
export const PAGE = { w: 713.04, h: 487.92 };
