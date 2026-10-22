/**
 * Table detection from ruling lines.
 *
 * These decks draw tables as thin filled rectangles — one per cell edge, not
 * one per grid line. Measured on page 7: 31 horizontal and 30 vertical rules
 * resolving to 8 row boundaries and 5 column boundaries.
 *
 * WHAT THIS DOES AND DOES NOT DO. It groups the rules and the text into a
 * logical `table` object so the editor can treat it as a table and the doctor
 * can check that every cell's text is bound to a cell. It deliberately does NOT
 * change what is emitted: the rules stay native rectangles and the text stays
 * in its own boxes, because that keeps geometry exact. Handing layout to a
 * DrawingML table would let PowerPoint decide cell sizes and text wrapping,
 * which is the class of surprise this project exists to avoid.
 */

/** A rect thinner than this in one axis is a rule, not a box. */
const RULE_MAX_THICKNESS = 3;
/** Rule positions within this distance (pt) are the same grid line. */
const LINE_TOL = 2.0;
/** Rules further apart than this do not belong to the same table. */
const CLUSTER_GAP = 24;

const isHRule = (b) => b.h <= RULE_MAX_THICKNESS && b.w > RULE_MAX_THICKNESS;
const isVRule = (b) => b.w <= RULE_MAX_THICKNESS && b.h > RULE_MAX_THICKNESS;

/** Collapse near-equal coordinates into single grid lines. */
function cluster(values, tol = LINE_TOL) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last.max <= tol) {
      last.max = v;
      last.items.push(v);
    } else {
      out.push({ min: v, max: v, items: [v] });
    }
  }
  return out.map((g) => g.items.reduce((s, v) => s + v, 0) / g.items.length);
}

/** Do two boxes touch or nearly touch? */
const near = (a, b, gap = CLUSTER_GAP) =>
  a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;

/**
 * Group rules into connected clusters — a page may hold more than one table,
 * and unrelated rules (footer separators, underlines) must not be pulled in.
 */
function clusterRules(rules) {
  const groups = [];
  for (const r of rules) {
    const hits = groups.filter((g) => g.some((m) => near(m._box, r._box)));
    if (!hits.length) { groups.push([r]); continue; }
    const merged = hits.flat().concat([r]);
    for (const h of hits) groups.splice(groups.indexOf(h), 1);
    groups.push(merged);
  }
  return groups;
}

/**
 * Detect tables on one page.
 * @param shapes model shape objects (bbox in page coordinates)
 * @param texts  model text objects
 */
export function detectTables(shapes, texts) {
  const rules = shapes.filter((s) => {
    const b = { x0: s.bbox.x, y0: s.bbox.y, x1: s.bbox.x + s.bbox.w, y1: s.bbox.y + s.bbox.h, w: s.bbox.w, h: s.bbox.h };
    s._box = b;
    return s.fill && (isHRule(b) || isVRule(b));
  });
  if (rules.length < 4) return [];

  const tables = [];
  for (const group of clusterRules(rules)) {
    const hs = group.filter((r) => isHRule(r._box));
    const vs = group.filter((r) => isVRule(r._box));
    // A table needs at least two rows and two columns of structure.
    if (hs.length < 2 || vs.length < 2) continue;

    const rowLines = cluster(hs.map((r) => (r._box.y0 + r._box.y1) / 2));
    const colLines = cluster(vs.map((r) => (r._box.x0 + r._box.x1) / 2));
    if (rowLines.length < 2 || colLines.length < 2) continue;

    const x0 = Math.min(...colLines), x1 = Math.max(...colLines);
    const y0 = Math.min(...rowLines), y1 = Math.max(...rowLines);
    if (x1 - x0 < 20 || y1 - y0 < 20) continue;

    // Cells are the boxes between consecutive grid lines.
    const cells = [];
    for (let r = 0; r < rowLines.length - 1; r++) {
      for (let c = 0; c < colLines.length - 1; c++) {
        cells.push({
          row: r, col: c,
          bbox: {
            x: +colLines[c].toFixed(2), y: +rowLines[r].toFixed(2),
            w: +(colLines[c + 1] - colLines[c]).toFixed(2),
            h: +(rowLines[r + 1] - rowLines[r]).toFixed(2),
          },
          textIds: [],
        });
      }
    }

    // Bind text to cells by centre containment — a block belongs to the cell it
    // sits in, not the cell it merely overlaps.
    for (const t of texts) {
      const cx = t.bbox.x + t.bbox.w / 2, cy = t.bbox.y + t.bbox.h / 2;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      const cell = cells.find(
        (k) => cx >= k.bbox.x && cx <= k.bbox.x + k.bbox.w && cy >= k.bbox.y && cy <= k.bbox.y + k.bbox.h
      );
      if (cell) cell.textIds.push(t.id);
    }

    tables.push({
      bbox: { x: +x0.toFixed(2), y: +y0.toFixed(2), w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2) },
      rows: rowLines.length - 1,
      cols: colLines.length - 1,
      rowLines: rowLines.map((v) => +v.toFixed(2)),
      colLines: colLines.map((v) => +v.toFixed(2)),
      cells,
      ruleIds: group.map((r) => r.id),
      boundText: cells.reduce((n, k) => n + k.textIds.length, 0),
    });
  }

  for (const s of shapes) delete s._box;
  return tables.sort((a, b) => a.bbox.y - b.bbox.y);
}
