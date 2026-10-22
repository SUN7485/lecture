/**
 * Recover what a PDF font really is, from its own FontDescriptor.
 *
 * Two separate lies live in font names, and both were costing fidelity:
 *
 * 1. MEASURED 2026-08-15 (Chp1-Lec1-3(New).pdf, slide 1): almost every heading on
 *    the title slide is drawn with a Type3 font, and MuPDF names those
 *    "Type3 (4 0 R)", "Type3 (7 0 R)" and so on. That name reached the model, the
 *    editor asked the browser for a family called "Type3 (4 0 R)", and the
 *    headings fell back to Segoe UI.
 *
 * 2. MEASURED 2026-08-15: the recovered name is itself misleading. Every one of
 *    those fonts is named `Cairo-ExtraLight`, and every one of them declares:
 *
 *        FontFamily (Cairo)   FontWeight 700   StemV 141/203   FontName /AAAAAA+Cairo-ExtraLight
 *
 *    The page renders BOLD. The subset name is a leftover from whatever cut the
 *    producer started from; the descriptor is the producer's explicit statement
 *    of what it drew. Trusting the name cost the user every bold heading on
 *    slide 1 — they came out thin in PowerPoint while the PDF is heavy.
 *
 * So: harvest the descriptor and let it speak. Keyed by BOTH the Type3 label and
 * the bare font name, so a non-Type3 font that declares a truthful weight is
 * covered by the same path. (In this corpus only the Type3 fonts declare
 * FontFamily/FontWeight at all — the others leave them null and fall back to the
 * name, which is correct for them.)
 *
 * This only makes the REQUEST truthful. Whether the face exists is the
 * resolver's question, and on this machine only Cairo Regular is installed, so
 * the doctor still reports the weight as approximated — which a user can act on.
 */

/** MuPDF's placeholder for an unnamed Type3 font, e.g. "Type3 (4 0 R)". */
const TYPE3_LABEL = /^Type3 \((\d+) 0 R\)$/;

export const isType3Label = (name) => TYPE3_LABEL.test(String(name ?? ""));

/** "/AAAAAA+Cairo-ExtraLight" -> "Cairo-ExtraLight", "(Cairo)" -> "Cairo". */
const clean = (v) =>
  String(v ?? "")
    .replace(/^\((.*)\)$/, "$1")
    .replace(/^\//, "")
    .replace(/^[A-Z]{6}\+/, "")
    .trim();

/**
 * Descriptor facts for every font in the document.
 *
 * @param {object} doc an opened mupdf Document
 * @returns {Map<string,{name:string,family:string,weight:number|null,italicAngle:number,stemV:number|null}>}
 *   keyed by the MuPDF Type3 label ("Type3 (4 0 R)") and by the bare font name
 *   ("Cairo-ExtraLight"), so either spelling finds the same facts.
 */
export function fontDescriptors(doc) {
  const map = new Map();
  const pdf = doc?.asPDF ? doc.asPDF() : doc;
  if (!pdf?.countObjects || !pdf?.newIndirect) return map;

  let total = 0;
  try { total = pdf.countObjects(); } catch { return map; }

  for (let i = 1; i < total; i++) {
    let obj;
    try { obj = pdf.newIndirect(i).resolve(); } catch { continue; }
    if (!obj?.isDictionary?.()) continue;

    let subtype = "";
    try { subtype = String(obj.get("Subtype") ?? ""); } catch { continue; }
    const isFont = subtype.includes("Type0") || subtype.includes("Type1") ||
      subtype.includes("Type3") || subtype.includes("TrueType");
    if (!isFont) continue;

    let desc;
    try {
      const fd = obj.get("FontDescriptor");
      desc = fd?.resolve ? fd.resolve() : fd;
    } catch { continue; }
    if (!desc?.get) continue;

    // MuPDF answers `get` with a PDFObject even when the key is ABSENT: PDF null
    // is an object, so `v == null` is false for it and `String(v)` is the
    // four-character word "null". That word then travels as a FontFamily, beats
    // the subset name (the descriptor is trusted over the name, correctly), and
    // matches no installed family — shipping `typeface="null"` in the OOXML.
    // Measured on the InDesign brand guide: DiodrumArabic-Medium and -Semibold
    // both declare a null FontFamily, and "Diodrum Arabic Medium" is installed.
    const read = (k) => {
      try {
        const v = desc.get(k);
        if (v == null) return null;
        return typeof v.isNull === "function" && v.isNull() ? null : v;
      } catch { return null; }
    };
    const name = clean(read("FontName"));
    if (!name) continue;

    const weightRaw = Number(clean(read("FontWeight")));
    const stemRaw = Number(clean(read("StemV")));
    const info = {
      name,
      family: clean(read("FontFamily")),
      weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : null,
      italicAngle: Number(clean(read("ItalicAngle"))) || 0,
      stemV: Number.isFinite(stemRaw) ? stemRaw : null,
    };

    if (subtype.includes("Type3")) map.set(`Type3 (${i} 0 R)`, info);
    // The bare name is shared between subsets of the same face; first one wins,
    // and they agree by construction (same producer, same source face).
    if (!map.has(name)) map.set(name, info);
  }

  return map;
}
