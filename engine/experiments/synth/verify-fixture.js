/**
 * FIXTURE VALIDITY. Does the exported PDF actually use the font the case asked for?
 *
 * WHY THIS IS A HARD GATE AND NOT A WARNING. The first targeted lam-alef population
 * produced 273 clean-looking numbers — RAW 58/273, MODEL 46/273, a tidy four-bucket
 * classification — and every one of them described CALIBRI. The cases requested
 * Diodrum Arabic, the .pptx declared `<a:cs typeface="Diodrum Arabic"/>` on the
 * Arabic run, and PowerPoint exported the PDF with Calibri glyphs anyway (with a
 * gid of -1 on the alef). A rule derived from that population would have been fitted
 * to a font nobody sets Arabic in, and it would have looked perfectly well-measured.
 *
 * A synthetic factory's whole value is that the truth is known. That guarantee dies
 * the moment the pipeline under test is fed something other than what was authored,
 * and nothing downstream can detect it — the scores stay plausible. So this runs
 * FIRST, and a failed fixture yields no accuracy number at all.
 *
 * Three layers, checked in order, because each can silently disagree with the last:
 *
 *   1 REQUESTED   the font named in cases.js
 *   2 DECLARED    the typeface in the .pptx run (<a:cs>, then <a:latin>)
 *   3 PAINTED     the font MuPDF reports for the Arabic glyphs in the exported PDF
 *
 * Usage: node experiments/synth/verify-fixture.js [--lam]
 * Exit:  0 valid · 1 substituted · 2 could not run
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as mupdf from "mupdf";
import JSZip from "jszip";
import { release } from "../../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "../lib-gate.js";

const TAG = process.argv.includes("--bidi") ? "bidi" : process.argv.includes("--space") ? "space" : process.argv.includes("--lam") ? "lam" : "synth";
const DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--") && fs.existsSync(a)) ?? "out/synth");
const PPTX = path.join(DIR, `${TAG}-source.pptx`);
const PDF = path.join(DIR, `${TAG}-powerpoint.pdf`);
const TRUTH = path.join(DIR, `${TAG}-truth.json`);

const RE_ARABIC = /[؀-ۿ]/;
/**
 * One family, however the PDF spells it.
 *
 * Strips the subset prefix ("BCDFEE+"), any style tail after a hyphen, and the
 * FUSED PostScript suffixes Monotype adds — `ArialMT`, `TimesNewRomanPSMT`. Without
 * that last part this gate calls a perfectly valid fixture substituted: the deck
 * asks for "Arial", the PDF paints "BCDFEE+ArialMT", and they are the same font.
 * The font resolver learned the same lesson separately (`psmt` in STYLE_WORDS).
 */
const family = (s) => String(s ?? "")
  .replace(/^[A-Z]{6}\+/, "")
  .replace(/[-,].*$/, "")
  .replace(/\s+/g, " ").trim().toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .replace(/(psmt|ps|mt)$/, "");

export async function verifyFixture({ quiet = false, tag = TAG } = {}) {
  const PPTX = path.join(DIR, tag + "-source.pptx");
  const PDF = path.join(DIR, tag + "-powerpoint.pdf");
  const TRUTH = path.join(DIR, tag + "-truth.json");
  for (const f of [PPTX, PDF, TRUTH]) {
    if (!fs.existsSync(f)) return { ok: false, reason: `missing ${path.basename(f)} — run build.js first`, rows: [] };
  }
  const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));

  // 2 DECLARED — the typeface on the run that actually carries the case text.
  const zip = await JSZip.loadAsync(fs.readFileSync(PPTX));
  const declared = new Map();
  for (const t of truth) {
    const xml = await zip.file(`ppt/slides/slide${t.slide}.xml`)?.async("string") ?? "";
    for (const m of xml.matchAll(/<a:r>[\s\S]*?<\/a:r>/g)) {
      const text = (m[0].match(/<a:t>([\s\S]*?)<\/a:t>/) ?? [, ""])[1];
      if (/^case \d+:/.test(text.trim())) continue;          // the scaffolding label
      const cs = (m[0].match(/<a:cs typeface="([^"]*)"/) ?? [])[1];
      const latin = (m[0].match(/<a:latin typeface="([^"]*)"/) ?? [])[1];
      // Arabic is complex script, so <a:cs> is the slot that decides it.
      declared.set(t.slide, (RE_ARABIC.test(text) ? cs : latin) ?? latin ?? cs ?? "");
      break;
    }
  }

  // 3 PAINTED — the font MuPDF reports for Arabic glyphs in the exported PDF.
  const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
  const painted = new Map();
  for (let i = 0; i < doc.countPages(); i++) {
    const seen = new Map();
    const dev = new mupdf.Device({
      fillText(text, ctm, cs) {
        try {
          text.walk({
            showGlyph(font, trm, gid, ucs) {
              if (!RE_ARABIC.test(String.fromCodePoint(ucs))) return;
              let n = "?"; try { n = font.getName?.() ?? "?"; } catch { /* borrowed */ }
              seen.set(n, (seen.get(n) ?? 0) + 1);
            },
          });
        } catch { /* a page with no text */ }
        release(text, cs);
      },
    });
    try { doc.loadPage(i).run(dev, mupdf.Matrix.identity); } finally { release(dev); }
    painted.set(i + 1, [...seen].sort((a, b) => b[1] - a[1]));
  }

  const rows = [];
  for (const t of truth) {
    if (!RE_ARABIC.test(t.text)) continue;                   // only Arabic cases are at risk
    const req = t.font;
    const dec = declared.get(t.slide) ?? "";
    const paint = painted.get(t.slide) ?? [];
    const top = paint[0]?.[0] ?? "(none painted)";
    const ok = paint.length > 0 && family(top) === family(req) && family(dec) === family(req);
    rows.push({ slide: t.slide, name: t.name, requested: req, declared: dec, painted: top, ok });
  }

  requireSubjects(rows.length, "Arabic cases", "the fixture contains no Arabic to validate");
  const bad = rows.filter((r) => !r.ok);

  if (!quiet) {
    console.log(`\nfixture validity — ${TAG}, ${rows.length} Arabic case(s)\n`);
    console.log(`  requested -> declared -> painted must be ONE family`);
    const byPaint = new Map();
    for (const r of rows) byPaint.set(r.painted, (byPaint.get(r.painted) ?? 0) + 1);
    for (const [f, n] of [...byPaint].sort((a, b) => b[1] - a[1])) console.log(`     painted: ${f}  x${n}`);
    if (bad.length) {
      console.log(`\n  ${bad.length} SUBSTITUTED case(s), first 3:`);
      for (const r of bad.slice(0, 3)) {
        console.log(`     slide ${r.slide} ${r.name}`);
        console.log(`        requested ${JSON.stringify(r.requested)}  declared ${JSON.stringify(r.declared)}  painted ${JSON.stringify(r.painted)}`);
      }
    }
  }

  return { ok: bad.length === 0, rows, bad, reason: bad.length ? `${bad.length} of ${rows.length} Arabic cases painted in a substituted font` : "" };
}

// Run directly: report and set an exit code. Imported: callers gate on `ok`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await verifyFixture();
  if (!r.rows.length) { console.error(`\nFIXTURE UNUSABLE: ${r.reason}\n`); process.exit(2); }
  console.log(r.ok
    ? "\n  FIXTURE VALID: every Arabic case is painted in the font it asked for.\n"
    : `\n  FIXTURE INVALID: ${r.reason}.\n  No accuracy score may be taken from it.\n`);
  process.exit(r.ok ? 0 : 1);
}
