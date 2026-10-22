/**
 * Where does `repairCollidedAlef` stop, corpus-wide?
 *
 * It fixed 7 blocks against a `DROPPED letter "ا"` class of 86, so either the
 * class is several defects or one of the gates is too tight. This counts every
 * device alef against each gate in turn, so the answer is a number rather than a
 * hunch.
 *
 *   node experiments/probe-collided-alef.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { deviceGlyphs } from "../src/extract/ligatures.js";
import { findPairs } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 6);
const SAME_POS = 0.6, SAME_BASELINE = 0.6, ZERO_W = 0.5;
const ALEF = new Set([0x0627, 0xfe8d, 0xfe8e, 0x0622, 0xfe81, 0xfe82, 0x0623, 0xfe83, 0xfe84, 0x0625, 0xfe87, 0xfe88]);
const charOf = (u) => ({ 0x0627: "ا", 0xfe8d: "ا", 0xfe8e: "ا", 0x0622: "آ", 0xfe81: "آ", 0xfe82: "آ", 0x0623: "أ", 0xfe83: "أ", 0xfe84: "أ", 0x0625: "إ", 0xfe87: "إ", 0xfe88: "إ" }[u]);

const stops = new Map();
const stop = (k) => stops.set(k, (stops.get(k) ?? 0) + 1);
const samples = new Map();
const sample = (k, s) => { const l = samples.get(k) ?? []; if (l.length < SAMPLES) { l.push(s); samples.set(k, l); } };

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");

  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const devs = deviceGlyphs(page);
    // Raw structured text, BEFORE any repair, so the gates are judged on what
    // they actually see.
    const st = [];
    page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces").walk({
      onChar(c, origin, font, size, quad) {
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        st.push({ c, x: origin[0], y: origin[1], x0: Math.min(...xs), x1: Math.max(...xs) });
      },
    });

    for (const dev of devs) {
      if (!ALEF.has(dev.unicode)) continue;
      const ch = charOf(dev.unicode);
      if (dev.advance < ZERO_W) { stop("1 device alef has no advance"); continue; }
      const row = st.filter((g) => Math.abs(g.y - dev.y) < SAME_BASELINE);
      const here = row.filter((g) => Math.abs(g.x - dev.x) < SAME_POS && g.c === ch);
      if (!here.length) { stop("2 stext has no alef at that position at all"); continue; }
      if (here.some((g) => g.x1 - g.x0 >= ZERO_W)) { stop("2 stext alef already has a real advance"); continue; }
      const tail = here[0];
      const lam = row.find((g) => g.c === "ل" && g.x1 - g.x0 >= ZERO_W && Math.abs(g.x1 - tail.x) < SAME_POS);
      if (!lam) {
        stop("3 no lam ends at the alef — not a ligature tail");
        sample("3 no lam ends at the alef — not a ligature tail",
          `${pair.name} p${p + 1} x ${dev.x.toFixed(2)}  neighbours: ` +
          row.filter((g) => Math.abs(g.x - dev.x) < 8).sort((a, b) => b.x - a.x)
            .map((g) => `${JSON.stringify(g.c)}[${g.x0.toFixed(1)}..${g.x1.toFixed(1)}]`).join(" "));
        continue;
      }
      stop("PASSES every gate");
    }
  }
}

for (const [k, v] of [...stops].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(v).padStart(6)}  ${k}`);
  for (const s of samples.get(k) ?? []) console.log(`        ${s}`);
}
