/**
 * The title-slide headings resolve to "Type3 (4 0 R)" and fall back to Segoe UI.
 *
 * KNOWN_ISSUES claims Type3 here is only the warning symbols and is low value.
 * Measured in the running editor, slide 1 of Chp1-Lec1-3(New) renders almost all
 * of its heading text in Type3 families, so that claim is wrong and this is the
 * visible font defect the user reported.
 *
 * Question: does the PDF carry any recoverable name for these fonts, or do we
 * have to substitute? Dumps every Type3 font object with whatever identifying
 * keys it has.
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.argv[2] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec1-3(New).pdf";
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const pdf = doc.asPDF ? doc.asPDF() : doc;

console.log(`objects: ${pdf.countObjects()}\n`);

let found = 0;
for (let i = 1; i < pdf.countObjects(); i++) {
  let obj;
  try { obj = pdf.newIndirect(i).resolve(); } catch { continue; }
  if (!obj || !obj.isDictionary?.()) continue;

  let subtype = "";
  try { subtype = String(obj.get("Subtype") ?? ""); } catch { }
  if (!subtype.includes("Type3")) continue;

  found++;
  const keys = [];
  try { obj.forEach((val, k) => keys.push(String(k))); } catch { }
  console.log(`obj ${i} 0 R  Subtype=${subtype}`);
  console.log(`  keys: ${keys.join(", ")}`);

  for (const k of ["Name", "BaseFont", "FontDescriptor", "Resources", "FontMatrix", "CharProcs", "Encoding"]) {
    let v;
    try { v = obj.get(k); } catch { continue; }
    if (v === undefined || v === null) continue;
    let shown = String(v);
    if (k === "FontDescriptor") {
      try {
        const fd = v.resolve ? v.resolve() : v;
        const fname = fd.get?.("FontName");
        shown = `-> FontName=${String(fname ?? "(none)")}`;
      } catch { shown = "(unreadable)"; }
    }
    if (k === "CharProcs") {
      try {
        const cp = v.resolve ? v.resolve() : v;
        const names = [];
        cp.forEach?.((val, name) => names.push(String(name)));
        shown = `${names.length} glyph procs: ${names.slice(0, 8).join(", ")}`;
      } catch { shown = "(unreadable)"; }
    }
    if (k === "Resources") {
      // A Type3 glyph proc that draws with ANOTHER font would name it here, and
      // that font is the real typeface we want.
      try {
        const rs = v.resolve ? v.resolve() : v;
        const f = rs.get?.("Font");
        const fr = f?.resolve ? f.resolve() : f;
        const inner = [];
        fr?.forEach?.((val, name) => {
          let base = "";
          try { const d = val.resolve ? val.resolve() : val; base = String(d.get("BaseFont") ?? ""); } catch { }
          inner.push(`${String(name)}=${base || "?"}`);
        });
        shown = inner.length ? `Font: ${inner.join(", ")}` : String(rs);
      } catch { shown = "(unreadable)"; }
    }
    console.log(`  ${k}: ${shown}`);
  }
  console.log();
  if (found >= 8) break;
}

console.log(found ? `\n${found} Type3 font object(s) shown.` : "No Type3 font objects found.");
