/**
 * Gate: a line the page painted on a rotated baseline must survive as ONE line,
 * carry its angle, and hand PowerPoint the UNROTATED box.
 *
 * Before this, the glyph walk read the quad and immediately collapsed it with
 * min/max, so the angle was thrown away and a rotated chart caption arrived as
 * a column of one-glyph lines drawn horizontally on top of one another. The
 * evidence was already in hand — `quad` is [ul, ur, ll, lr], and ul->ur is the
 * baseline direction.
 *
 * Census that scopes this: 42 rotated glyphs in 603896 across 29 documents, all
 * at -90, and ZERO in the 28-deck corpus. So the upright pipeline is not merely
 * unchanged by the rotated path, it is unreachable from it.
 *
 * Run: node experiments/verify-rotated-text.js [pdf]
 */
import * as fs from "node:fs";
import { modelFromPdf } from "../src/model/normalize.js";

const PDF = process.argv[2]
  ?? "C:\\Users\\mosun\\Downloads\\ﻫﻨﺪﺳﺔ اﻟﻌﻤﻠﻴﺎت واﻟﻠﻮﺟﺴﺘﻴﺎت اﻟﺼﻨﺎﻋﻴﺔ - الوحدة الخامسة.pdf";
if (!fs.existsSync(PDF)) {
  console.error(`SKIP — ${PDF} not on this machine; pass a pdf with rotated text.`);
  process.exit(0);
}

// The two chart captions in Unit Five, and what they must read.
const EXPECT = [
  { page: 103, rotation: -90, text: "التكلفة السنوية (ريال)" },
  { page: 107, rotation: -90, text: "مستوى المخزون (وحدة)" },
];

const fail = [];
for (const want of EXPECT) {
  const page = modelFromPdf(PDF, { pages: [want.page - 1] }).pages[0];
  const rotated = page.objects.filter((o) => o.type === "text" && o.rotation);

  if (rotated.length !== 1) {
    fail.push(`p${want.page}: expected 1 rotated line, got ${rotated.length}`);
    continue;
  }
  const o = rotated[0];
  if (o.rotation !== want.rotation) fail.push(`p${want.page}: rotation ${o.rotation}, expected ${want.rotation}`);
  if (o.text !== want.text) fail.push(`p${want.page}: read "${o.text}", expected "${want.text}"`);
  // A vertical caption's INK extent is taller than it is wide. If this ever
  // inverts, the glyphs were regrouped as an upright line and the angle is a lie.
  if (o.bbox.h <= o.bbox.w) {
    fail.push(`p${want.page}: ink box ${o.bbox.w}x${o.bbox.h} is not portrait — the line was grouped upright`);
  }
  // Every glyph of the caption must be in THIS line, not scattered as singletons.
  const singles = page.objects.filter((x) => x.type === "text" && !x.rotation && (x.text || "").trim().length === 1).length;
  if (singles > 6) fail.push(`p${want.page}: ${singles} one-character upright lines — rotated glyphs are still leaking`);
}

if (fail.length) {
  console.error("FAIL — verify-rotated-text");
  for (const f of fail) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("PASS — verify-rotated-text");
for (const e of EXPECT) console.log(`  p${e.page}  ${e.rotation}deg  "${e.text}"`);
