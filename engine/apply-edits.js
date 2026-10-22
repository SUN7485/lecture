/**
 * Editor edits -> normalized model.
 *
 * The missing half of `model-to-html.js`. That file projects the model into
 * editable HTML; this one folds the user's edits back into the model, so the
 * model stays authoritative AND what the user typed is what gets exported.
 *
 * WHY THIS EXISTS: without it the two are silently different documents. Proven
 * before it was written — a word changed in the editor appeared in the exported
 * PDF (rendered from HTML) and was absent from the exported PPTX (written from
 * the model). Same session, same deck, two buttons, two answers.
 *
 * The reconciliation is driven by `data-id`, which `model-to-html.js` writes on
 * every object, and it is computed IN THE BROWSER — the DOM is the authority on
 * what the user actually sees, and sending object state avoids parsing
 * browser-serialized HTML on the server.
 *
 * Fidelity contract, stated precisely because it is a real trade:
 *   - An object the user did NOT touch keeps its runs byte-for-byte, and with
 *     them every per-glyph fact the reconstruction recovered.
 *   - An object whose TEXT changed keeps the styling of its first run and
 *     collapses to a single run. Mixed styling inside that one object is lost.
 *     For the dominant edit — fixing a word — this is exactly right, and it is
 *     the only honest option: the model cannot know which glyphs of the new
 *     string inherited which of the old runs.
 */

/** Geometry differences below this (in points) are layout noise, not an edit. */
const MOVE_EPSILON = 0.5;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function bboxChanged(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) > MOVE_EPSILON ||
    Math.abs(a.y - b.y) > MOVE_EPSILON ||
    Math.abs(a.w - b.w) > MOVE_EPSILON ||
    Math.abs(a.h - b.h) > MOVE_EPSILON
  );
}

/**
 * Rewrite an object's text, keeping as much of its identity as is still true.
 *
 * The diagnostic flags are CLEARED deliberately. `charactersMissing` and
 * `lamAlefLost` are claims about the original extraction; once a human has
 * retyped the string they are stale, and leaving them set would let a later
 * repair pass "fix" text the user just corrected.
 */
function rewriteText(obj, text) {
  const first = obj.runs && obj.runs.length ? obj.runs[0] : null;
  obj.text = text;
  obj.runs = [
    {
      ...(first || {}),
      text,
      // srcX/srcW described where the ORIGINAL glyphs sat on the source page.
      // They are measurements, not styling, and they no longer describe this
      // string — carrying them forward would corrupt the fidelity check that
      // compares rendered width against them.
      srcX: undefined,
      srcW: undefined
    }
  ];
  // Cell geometry belongs to the text that was extracted from those cells.
  if (obj.tableSegments) delete obj.tableSegments;
  if (obj.tableSourceText) delete obj.tableSourceText;
  obj.charactersMissing = 0;
  obj.lamAlefLost = false;
  obj.provenance = { ...(obj.provenance || {}), edited: true };
}

function moveObject(obj, bbox) {
  const dx = bbox.x - obj.bbox.x;
  const dy = bbox.y - obj.bbox.y;
  obj.bbox = { ...obj.bbox, ...bbox };
  // Table segments carry ABSOLUTE coordinates, so moving the parent without
  // moving them leaves the cells behind on the page.
  if (Array.isArray(obj.tableSegments) && (dx || dy)) {
    for (const seg of obj.tableSegments) {
      if (seg && seg.bbox) { seg.bbox.x += dx; seg.bbox.y += dy; }
    }
  }
  obj.provenance = { ...(obj.provenance || {}), edited: true };
}

/** A text object built from something the user added in the editor. */
function synthesizeText(entry, index) {
  const size = num(entry.fontSizePt) || 12;
  return {
    id: `edit_text_${index}`,
    type: "text",
    bbox: entry.bbox,
    zIndex: num(entry.zIndex) != null ? entry.zIndex : 900 + index,
    text: entry.text,
    paragraphDirection: entry.dir === "rtl" ? "rtl" : "ltr",
    alignment: entry.align || (entry.dir === "rtl" ? "right" : "left"),
    runs: [
      {
        text: entry.text,
        fontFamily: entry.fontFamily || "Segoe UI",
        fontSizePt: size,
        color: (entry.color || "000000").replace(/^#/, ""),
        bold: !!entry.bold,
        italic: !!entry.italic,
        script: entry.dir === "rtl" ? "Arab" : "Latn"
      }
    ],
    reconstructionStrategy: "user-authored",
    charactersMissing: 0,
    lamAlefLost: false,
    provenance: { authored: true }
  };
}

/**
 * Fold the editor's current object state into the model.
 *
 * @param {object} model    the normalized model (MUTATED in place)
 * @param {Array}  entries  one per object currently on the canvas:
 *                          { id, text?, bbox? } for known objects, or
 *                          { isNew:true, page, kind:'text', text, bbox, ... }
 * @returns {{textChanged:number, moved:number, deleted:number, added:number, unknown:number}}
 */
export function applyDeckEdits(model, entries) {
  const stats = { textChanged: 0, moved: 0, deleted: 0, added: 0, unknown: 0 };
  if (!model || !Array.isArray(model.pages)) return stats;
  if (!Array.isArray(entries) || entries.length === 0) return stats;

  const byId = new Map();
  for (const page of model.pages) {
    for (const obj of page.objects || []) byId.set(obj.id, { obj, page });
  }

  const seen = new Set();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    if (entry.isNew) {
      const page = model.pages[num(entry.page) ?? -1];
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (!page || entry.kind !== "text" || !text || !entry.bbox) { stats.unknown++; continue; }
      page.objects.push(synthesizeText(entry, i));
      stats.added++;
      continue;
    }

    const found = byId.get(entry.id);
    if (!found) { stats.unknown++; continue; }
    seen.add(entry.id);
    const { obj } = found;

    if (obj.type === "text" && typeof entry.text === "string" && entry.text !== obj.text) {
      rewriteText(obj, entry.text);
      stats.textChanged++;
    }

    if (entry.bbox && bboxChanged(obj.bbox, entry.bbox)) {
      moveObject(obj, entry.bbox);
      stats.moved++;
    }
  }

  // Anything the model still has that the canvas no longer shows was deleted.
  // Soft masks are never rendered (see model-to-html.js), so they were never on
  // the canvas to begin with and must not be mistaken for deletions.
  for (const page of model.pages) {
    const before = page.objects.length;
    page.objects = page.objects.filter(
      (o) => seen.has(o.id) || (o.type === "image" && o.isMask) || o.provenance?.authored
    );
    stats.deleted += before - page.objects.length;
  }

  return stats;
}
