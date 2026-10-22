/**
 * A token-level atlas of the same-token mixed-script bidi failures.
 *
 * RAW scores 100.00% recall on this population and MODEL 91.46%, so the correct
 * order is entirely present in what MuPDF hands us and our reconstruction destroys
 * it. This file finds WHERE, and what evidence still carries the truth at that
 * point, so a fix can preserve rather than repair.
 *
 * Per failing case it records the stext STREAM order beside the x-sorted order the
 * block ends up in, the bidi class and script of every character, and the geometry.
 * Families come from the shape of the diff, never from the case name (EVO-035).
 *
 * Usage: node experiments/synth/atlas-bidi.js [--show N] [--json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { stextGlyphs, buildLines, extractGlyphs, blockText, blockIsRtl } from "../../src/extract/glyphs.js";
import { modelFromPdf } from "../../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { release } from "../../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const DIR = path.resolve("out/synth");
const PDF = path.join(DIR, "bidi-powerpoint.pdf");
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 6);

const fixture = await verifyFixture({ quiet: true, tag: "bidi" });
if (!fixture.ok) { console.error(`\n  FIXTURE INVALID: ${fixture.reason}\n`); process.exit(2); }

const truth = JSON.parse(fs.readFileSync(path.join(DIR, "bidi-truth.json"), "utf8"));
requireSubjects(truth.length, "cases", "bidi-truth.json is empty");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const notLabel = (s) => !/^case \d+:/.test(String(s).trim());

/** A character's bidi class, coarse but enough to name a family. */
const bidiClass = (c) => {
  const cp = c.codePointAt(0);
  if (/[؀-ۿ]/.test(c)) return "AL";                 // Arabic letter
  if (/[A-Za-z]/.test(c)) return "L";
  if (/[0-9]/.test(c)) return "EN";                           // European number
  if (/[٠-٩]/.test(c)) return "AN";                 // Arabic-Indic number
  if (/[+\-]/.test(c)) return "ES";                           // European separator
  if (/[.,:/]/.test(c)) return "CS";                          // common separator
  if (/[%$#]/.test(c)) return "ET";                           // European terminator
  if (c === " ") return "WS";
  return "ON";                                                // other neutral
};

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const rawOf = (i) => {
  const st = doc.loadPage(i).toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
  try { return norm(st.asText().replace(/^case \d+ ?:.*$/gm, "")); } finally { release(st); }
};

const model = modelFromPdf(PDF);
const repaired = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(repaired, rule);
const textOf = (m, i) => norm((m.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text").map((o) => o.text).filter(notLabel).join(" "));

const rows = [];
for (const t of truth) {
  const i = t.slide - 1;
  const want = norm(t.text);
  const raw = rawOf(i), mdl = textOf(model, i), del = textOf(repaired, i);
  if (del.includes(want)) continue;

  // The stream as structured text emits it, versus the block after buildLines has
  // ordered it by x. If the first is right and the second is wrong, the sort is
  // the stage that destroys the answer.
  const page = doc.loadPage(i);
  const stream = stextGlyphs(page).filter((g) => notLabel(g.c)).map((g) => g.c).join("");
  const blocks = buildLines(extractGlyphs(page));
  const sorted = blocks.map((b) => blockText(b, blockIsRtl(b))).join(" ");

  const tok = t.meta?.token ?? "";
  rows.push({
    name: t.name, want, raw, model: mdl, delivered: del,
    token: tok, shape: t.meta?.shape ?? "?", atomic: !!t.meta?.atomic,
    classes: [...tok].map((c) => `${c}:${bidiClass(c)}`).join(" "),
    streamHasToken: stream.includes(tok),
    sortedHasToken: sorted.includes(tok),
    rawHasToken: raw.includes(tok),
    deliveredHasToken: del.includes(tok),
  });
}

requireSubjects(rows.length, "failing cases", "nothing failed — did the population change?");

console.log(`\nbidi-token atlas — ${rows.length} failing of ${truth.length}\n`);

const tally = (key) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
};
console.log(`  shape        ${tally("shape")}`);
console.log(`  atomic       ${rows.filter((r) => r.atomic).length} of ${rows.length}`);

console.log(`\n  WHERE THE TOKEN IS STILL INTACT`);
console.log(`     in RAW structured text        ${rows.filter((r) => r.rawHasToken).length}/${rows.length}`);
console.log(`     in the stext STREAM order     ${rows.filter((r) => r.streamHasToken).length}/${rows.length}`);
console.log(`     after buildLines x-sorting    ${rows.filter((r) => r.sortedHasToken).length}/${rows.length}`);
console.log(`     in the DELIVERED text         ${rows.filter((r) => r.deliveredHasToken).length}/${rows.length}`);

// Families from the diff shape, not the name.
const fam = new Map();
for (const r of rows) {
  const t = r.token;
  let k = "other";
  if (t && r.delivered.includes([...t].reverse().join(""))) k = "token fully reversed";
  else if (t.length > 1 && r.delivered.includes(t.slice(1) + t[0])) k = "leading char moved to the end";
  else if (t.length > 1 && r.delivered.includes(t[t.length - 1] + t.slice(0, -1))) k = "trailing char moved to the front";
  else if (!r.delivered.includes(t)) k = "token altered some other way";
  fam.set(k, (fam.get(k) ?? 0) + 1);
}
console.log(`\n  failure families:`);
for (const [k, v] of [...fam].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(4)}  ${k}`);

console.log(`\n  first ${Math.min(SHOW, rows.length)}:`);
for (const r of rows.slice(0, SHOW)) {
  console.log(`\n  ${r.name}  [${r.shape}${r.atomic ? " · atomic" : ""}]  token ${JSON.stringify(r.token)}`);
  console.log(`     classes  ${r.classes}`);
  console.log(`     want     ${JSON.stringify(r.want)}`);
  console.log(`     raw      ${JSON.stringify(r.raw.slice(0, 56))}`);
  console.log(`     deliv    ${JSON.stringify(r.delivered.slice(0, 56))}`);
  console.log(`     intact in: raw ${r.rawHasToken} · stream ${r.streamHasToken} · sorted ${r.sortedHasToken}`);
}

if (process.argv.includes("--json")) {
  fs.writeFileSync(path.join(DIR, "bidi-atlas.json"), JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n  wrote ${path.join(DIR, "bidi-atlas.json")}`);
}
console.log("");
