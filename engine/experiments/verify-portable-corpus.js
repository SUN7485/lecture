/**
 * Every .pptx in out/, through the portable rewrite, checked at the ARTIFACT.
 *
 * WHY: `refontPptx` was built and verified on ONE deck — the one a reader
 * complained about. That proves nothing about the next document (EVO-027), and
 * this project's expensive bugs have all arrived on a document unlike the
 * corpus: an InDesign export whose Lyon subset names lack the `LF` infix, a
 * CMYK PDF where every colour was a 3-float triple, a merged file carrying
 * three page geometries. So the sweep runs over everything on disk and asserts
 * four things per deck:
 *
 *   leftover  0  no typeface the reader might not have survived the rewrite
 *   chinese   0  no run still announces GB2312 or Big5 (see DOCS.md)
 *   uncovered 0  no family was refused because nothing ubiquitous can draw it
 *   text    same  the delivered string is byte-identical, so a FONT pass cannot
 *                 be quietly moving characters
 *
 * Run: node experiments/verify-portable-corpus.js
 * Last run 2026-08-25: 54 decks, 54 clean, 0 problems.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { refontPptx } from '../src/pptx/refont.js';
import { UBIQUITOUS_FONTS } from '../src/pptx/inspect.js';

const decks = fs.readdirSync('out').filter(f => f.endsWith('.pptx')).sort();
const textOf = (file) => new AdmZip(file).getEntries()
  .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
  .sort((a,b) => +a.entryName.match(/\d+/)[0] - +b.entryName.match(/\d+/)[0])
  .map(e => [...e.getData().toString('utf8').matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m=>m[1]).join(' ')).join('');

let ok = 0; const problems = [];
console.log('deck'.padEnd(52), 'runs'.padStart(6), 'swap'.padStart(6), 'chset'.padStart(6), 'left'.padStart(5), 'uncov'.padStart(6), 'text');
for (const d of decks) {
  const src = path.join('out', d);
  const dest = path.join(os.tmpdir(), 'corpus-' + Math.random().toString(36).slice(2) + '.pptx');
  try {
    const r = await refontPptx(src, dest);
    const zip = new AdmZip(dest);
    let leftover = 0, chinese = 0;
    for (const e of zip.getEntries()) {
      if (!/^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/.+\.xml$/.test(e.entryName)) continue;
      const x = e.getData().toString('utf8');
      for (const m of x.matchAll(/typeface="([^"]*)"/g)) {
        const t = m[1];
        if (!t || t.startsWith('+') || UBIQUITOUS_FONTS.has(t.toLowerCase())) continue;
        leftover++;
      }
      chinese += [...x.matchAll(/charset="(-12[02])"/g)].length;
    }
    const textSame = textOf(src) === textOf(dest);
    const bad = leftover > 0 || chinese > 0 || r.uncovered.length > 0 || !textSame;
    if (bad) problems.push({ d, leftover, chinese, uncovered: r.uncovered, textSame });
    else ok++;
    console.log(d.slice(0,52).padEnd(52), String(r.runs).padStart(6), String(r.rewritten).padStart(6),
      String(r.charsetFixed).padStart(6), String(leftover).padStart(5), String(r.uncovered.length).padStart(6),
      textSame ? 'same' : '*** CHANGED ***', bad ? ' <== PROBLEM' : '');
  } catch (e) {
    problems.push({ d, error: e.message.slice(0,90) });
    console.log(d.slice(0,52).padEnd(52), 'ERROR', e.message.slice(0,60));
  } finally { fs.rmSync(dest, { force: true }); }
}
console.log(`\ndecks: ${decks.length} · clean: ${ok} · problems: ${problems.length}`);
for (const p of problems) console.log('  ', JSON.stringify(p));
