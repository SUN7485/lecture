/**
 * THE RTL ORACLE, AUDITED IN BOTH DIRECTIONS.
 *
 * `src/pptx/inspect.js` builds its "wanted" set as
 *   textIsRtl(t) && RE_ARABIC.test(t)
 * so a paragraph that carries rtl="1" with NO Arabic in it can never be counted
 * as wrong. The gate sees a MISSING direction and is structurally blind to an
 * INVENTED one. This measures both.
 *
 * Terminates at the artifact: the paragraphs are read out of the .pptx the real
 * writer produced, not re-derived from the model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { modelFromPdf } from "../src/model/normalize.js";
import { writePptx } from "../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { textIsRtl } from "../src/extract/bidi.js";
import { findPairs } from "../src/truth/corpus.js";

const RE_ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const RE_LATIN = /[A-Za-z]/;
const RE_DIGIT = /[0-9]/;
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const extra = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = [...findPairs().map((p) => p.pdf), ...extra];

const tmp = path.join(os.tmpdir(), "rtl-oracle");
fs.mkdirSync(tmp, { recursive: true });

const counts = { agreeRtl: 0, agreeLtr: 0, over: 0, under: 0 };
const over = [], under = [];
let paras = 0, decks = 0;

for (const pdf of files) {
  const name = path.basename(pdf).replace(/\.pdf$/i, "");
  let model;
  try { model = modelFromPdf(pdf); } catch (e) { console.log(`  SKIP ${name}: ${e.message}`); continue; }
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  const out = path.join(tmp, `${name}.pptx`);
  await writePptx(model, out);
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  decks++;
  for (const sn of slideNames) {
    const si = +sn.match(/\d+/)[0];
    const xml = await zip.file(sn).async("string");
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      const text = (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
        .map((t) => decode(t.replace(/<\/?a:t>/g, ""))).join("");
      if (!text.trim()) continue;
      paras++;
      const shipped = /<a:pPr[^>]*\brtl="1"/.test(p);
      const oracle = textIsRtl(text);
      if (shipped && oracle) counts.agreeRtl++;
      else if (!shipped && !oracle) counts.agreeLtr++;
      else if (shipped && !oracle) { counts.over++; over.push({ name, si, text }); }
      else { counts.under++; under.push({ name, si, text }); }
    }
  }
  fs.rmSync(out, { force: true });
}

const cls = (t) => {
  const a = RE_ARABIC.test(t), l = RE_LATIN.test(t), d = RE_DIGIT.test(t);
  if (a && l) return "MIXED_ar_lat";
  if (a) return "ARABIC_only";
  if (l) return "LATIN_only";
  if (d) return "NUMERIC_only";
  return "SYMBOL_only";
};
const tally = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(cls(r.text), (m.get(cls(r.text)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

console.log(`\nRTL ORACLE AUDIT — ${decks} decks · ${paras} paragraphs\n`);
console.log(`  shipped rtl, oracle rtl (agree)   ${String(counts.agreeRtl).padStart(6)}`);
console.log(`  shipped ltr, oracle ltr (agree)   ${String(counts.agreeLtr).padStart(6)}`);
console.log(`  shipped RTL, oracle ltr  OVER     ${String(counts.over).padStart(6)}   <- the gate is blind to these`);
console.log(`  shipped ltr, oracle RTL  UNDER    ${String(counts.under).padStart(6)}`);

for (const [label, rows] of [["OVER-MARKED", over], ["UNDER-MARKED", under]]) {
  if (!rows.length) continue;
  console.log(`\n${label} by content class:`);
  for (const [k, n] of tally(rows)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  console.log(`${label} samples:`);
  const byClass = new Map();
  for (const r of rows) {
    const k = cls(r.text);
    if (!byClass.has(k)) byClass.set(k, []);
    if (byClass.get(k).length < 6) byClass.get(k).push(r);
  }
  for (const [k, rs] of byClass) for (const r of rs)
    console.log(`  ${k.padEnd(13)} ${r.name} p${r.si}  ${JSON.stringify(r.text.slice(0, 72))}`);
}
