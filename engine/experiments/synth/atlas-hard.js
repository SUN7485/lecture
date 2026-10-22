/**
 * An atlas of the HARD cases — the ones neither MuPDF nor our repairs get right.
 *
 * THE QUESTION THIS EXISTS TO ANSWER. 133 of 273 lam-alef cases come back wrong at
 * both RAW and MODEL. Before anyone writes a rule, or prices a second extraction
 * engine, one thing has to be established:
 *
 *     does the DEVICE/GLYPH evidence still contain the logical order that the
 *     structured-text layer lost?
 *
 * If it does, the fix belongs in the glyph-level resolver this project already has,
 * and no second witness is justified. If it does not — if the page genuinely paints
 * lam and alef with nothing that says which came first — then that is the first
 * honest justification for PDFium, and it will be backed by a measurement instead of
 * an architecture argument.
 *
 * A lam-alef is ONE glyph standing for TWO characters. The evidence that decides the
 * question is whether the device reports it as a single glyph naming a PRESENTATION
 * FORM (U+FEFB and friends, which decompose with no font parsing — this is how the
 * Chrome path was solved), or as two ordinary glyphs whose order is all we have.
 *
 * Usage: node experiments/synth/atlas-hard.js [--show N] [--json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { modelFromPdf } from "../../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { release } from "../../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const DIR = path.resolve("out/synth");
const PDF = path.join(DIR, "lam-powerpoint.pdf");
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 5);

const fixture = await verifyFixture({ quiet: true, tag: "lam" });
if (!fixture.ok) { console.error(`\n  FIXTURE INVALID: ${fixture.reason}\n`); process.exit(2); }

const truth = JSON.parse(fs.readFileSync(path.join(DIR, "lam-truth.json"), "utf8"));
requireSubjects(truth.length, "cases", "lam-truth.json is empty");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const strip = (s) => norm(s).replace(/\s/g, "");
const notLabel = (s) => !/^case \d+:/.test(String(s).trim());

/** Arabic PRESENTATION FORMS for lam-alef: the glyph that says what it stands for. */
const LIGATURE_FORMS = new Set([0xFEF5, 0xFEF6, 0xFEF7, 0xFEF8, 0xFEF9, 0xFEFA, 0xFEFB, 0xFEFC]);
const isPresentationForm = (cp) => cp >= 0xFB50 && cp <= 0xFEFF;
const RE_MARK = /[ً-ٰٟ]/;

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

/** Every glyph the DEVICE painted on a page, in paint order, with its x. */
function deviceGlyphs(pageIndex) {
  const out = [];
  const dev = new mupdf.Device({
    fillText(text, ctm, cs) {
      try {
        text.walk({
          showGlyph(font, trm, gid, ucs) {
            let n = "?"; try { n = font.getName?.() ?? "?"; } catch { /* borrowed */ }
            out.push({ gid, ucs, ch: String.fromCodePoint(ucs), font: n, x: +(trm[4]).toFixed(2) });
          },
        });
      } catch { /* no text on the page */ }
      release(text, cs);
    },
  });
  try { doc.loadPage(pageIndex).run(dev, mupdf.Matrix.identity); } finally { release(dev); }
  return out;
}

const rawOf = (i) => {
  const st = doc.loadPage(i).toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
  try { return norm(st.asText().replace(/^case \d+ ?:.*$/gm, "")); } finally { release(st); }
};

const model = modelFromPdf(PDF);
const rawModel = modelFromPdf(PDF);            // before repairs, for the MODEL column
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
const textOf = (m, i) => norm((m.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text").map((o) => o.text).filter(notLabel).join(" "));

const rows = [];
for (const t of truth) {
  const i = t.slide - 1;
  const want = strip(t.text);
  const raw = strip(rawOf(i));
  const mdl = strip(textOf(rawModel, i));
  const del = strip(textOf(model, i));
  if (raw.includes(want) || del.includes(want)) continue;      // not HARD

  // Only the glyphs of the case text, not the Arial label.
  const glyphs = deviceGlyphs(i).filter((g) => /[؀-ۿﭐ-﻿]/.test(g.ch));
  const forms = glyphs.filter((g) => isPresentationForm(g.ucs));
  const ligs = glyphs.filter((g) => LIGATURE_FORMS.has(g.ucs));
  const unmapped = glyphs.filter((g) => g.gid === -1 || g.ucs === 0xFFFD);

  rows.push({
    name: t.name, want, raw, model: mdl, delivered: del,
    variant: t.meta?.form ?? "?", position: t.meta?.position ?? "?", context: t.meta?.context ?? "?",
    diacritic: RE_MARK.test(t.text), punctuation: /[.،؛:()]/.test(t.text),
    glyphCount: glyphs.length,
    presentationForms: forms.length,
    ligatureGlyphs: ligs.length,
    unmappedGlyphs: unmapped.length,
    // The whole question, per case: is the ligature reported as a glyph that NAMES
    // itself, or as two ordinary characters whose order is the only evidence?
    evidence: ligs.length ? "LIGATURE-NAMED" : forms.length ? "PRESENTATION-FORM" : "PLAIN-CHARS",
    glyphs: glyphs.map((g) => `${g.ch}@${g.x}${g.gid === -1 ? "(gid-1)" : ""}`).join(" "),
  });
}

requireSubjects(rows.length, "HARD cases", "nothing classified HARD — did the population change?");

console.log(`\nHARD-case atlas — ${rows.length} of ${truth.length} cases\n`);

const tally = (key) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
};
console.log(`  variant      ${tally("variant")}`);
console.log(`  position     ${tally("position")}`);
console.log(`  context      ${tally("context")}`);
console.log(`  diacritic    ${rows.filter((r) => r.diacritic).length} of ${rows.length}`);
console.log(`  punctuation  ${rows.filter((r) => r.punctuation).length} of ${rows.length}`);

console.log(`\n  DEVICE EVIDENCE — can the glyph layer still name the ligature?`);
console.log(`  ${tally("evidence")}`);
console.log(`  unmapped glyphs (gid -1 or U+FFFD): ${rows.filter((r) => r.unmappedGlyphs > 0).length} case(s)`);

// Failure families: the shape of the diff, not the bucket name (EVO-035).
const fam = new Map();
for (const r of rows) {
  const w = [...r.want], g = [...r.delivered];
  let k = "other";
  // The signature that matters: the two characters of the cluster, swapped.
  const swapped = w.some((c, j) => j + 1 < w.length && r.delivered.includes(w[j + 1] + c));
  if (swapped) k = "cluster reversed (2 chars swapped)";
  else if (g.length < w.length) k = `characters lost (${w.length - g.length})`;
  else if (g.length > w.length) k = `characters added (${g.length - w.length})`;
  fam.set(k, (fam.get(k) ?? 0) + 1);
}
console.log(`\n  failure families:`);
for (const [k, v] of [...fam].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`);

console.log(`\n  first ${Math.min(SHOW, rows.length)} cases:`);
for (const r of rows.slice(0, SHOW)) {
  console.log(`\n  ${r.name}  [${r.variant} · ${r.position} · ${r.context} · ${r.evidence}]`);
  console.log(`     want   ${JSON.stringify(r.want)}`);
  console.log(`     raw    ${JSON.stringify(r.raw.slice(0, 50))}`);
  console.log(`     deliv  ${JSON.stringify(r.delivered.slice(0, 50))}`);
  console.log(`     glyphs ${r.glyphs.slice(0, 120)}`);
}

if (process.argv.includes("--json")) {
  fs.writeFileSync(path.join(DIR, "hard-atlas.json"), JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n  wrote ${path.join(DIR, "hard-atlas.json")}`);
}
console.log("");
