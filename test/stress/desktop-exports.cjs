'use strict';
// Desktop export survey: each deck opened in the real Electron app, exported
// to PDF (Chromium printToPDF) and to verified PPTX (rendered in real desktop
// PowerPoint and compared). Measures, does not assert — the report is the point.
// Slow by nature (~1 min per PPTX). Usage: node test/stress/desktop-exports.cjs [deck.html ...]
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('../support/launch-electron');
const AdmZip = require('adm-zip');

const AR = /[؀-ۿ]/;
const decks = process.argv.slice(2).length ? process.argv.slice(2) : [
  path.join(ROOT, '.preview', 'corpus', 'bilingual-deck.html'),
  path.join(ROOT, '.preview', 'corpus', 'english-deck.html'),
  path.join(ROOT, '.preview', 'corpus', 'chatgpt-deck.html'),
  path.join(ROOT, 'Chp1-Lec1-2.html')
];

async function exportOnce(deck, button, ext) {
  // Inside ROOT so the commit stays on one volume regardless of the EXDEV fix.
  const out = path.join(fs.mkdtempSync(path.join(ROOT, '.fidelity', 'survey-')), 'out.' + ext);
  const { app, page } = await launchLve({ open: deck, exportPath: out });
  const t0 = Date.now();
  try {
    await page.waitForFunction(() => window.__editor, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const slides = await page.evaluate(() => window.__editor.slides().length);
    await page.click(button);
    let waited = 0;
    while (!fs.existsSync(out) && waited < 600) { await new Promise((r) => setTimeout(r, 1000)); waited++; }
    await new Promise((r) => setTimeout(r, 800));
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    return { slides, out: fs.existsSync(out) ? out : null, ms: Date.now() - t0, status };
  } finally { await app.close(); }
}

(async () => {
  const mupdf = await import(require('node:url').pathToFileURL(path.join(ROOT, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href);
  for (const deck of decks) {
    const row = { deck: path.basename(deck) };
    try {
      const pdf = await exportOnce(deck, '#btn-export', 'pdf');
      row.slides = pdf.slides;
      row.pdf = pdf.out ? { pages: mupdf.Document.openDocument(fs.readFileSync(pdf.out), 'application/pdf').countPages(), s: Math.round(pdf.ms / 1000) } : 'NOT WRITTEN: ' + pdf.status;
      const pp = await exportOnce(deck, '#btn-export-pptx', 'pptx');
      if (pp.out) {
        const zip = new AdmZip(pp.out);
        const parts = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
        let runs = 0, arNoRtl = 0, rtlNoAr = 0;
        for (const e of parts) for (const p of e.getData().toString('utf8').match(/<a:p>[\s\S]*?<\/a:p>/g) || []) {
          const t = (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).join('');
          if (!t) continue; runs++;
          const rtl = /rtl="1"/.test(p);
          if (AR.test(t) && !rtl) arNoRtl++;
          if (!AR.test(t) && rtl && /[A-Za-z]{3}/.test(t)) rtlNoAr++;
        }
        row.pptx = { slides: parts.length, paragraphs: runs, arNoRtl, rtlNoAr, s: Math.round(pp.ms / 1000), status: pp.status.slice(0, 140) };
      } else row.pptx = 'NOT WRITTEN: ' + pp.status.slice(0, 200);
    } catch (e) { row.error = e.message.split('\n')[0]; }
    console.log(JSON.stringify(row));
  }
})();
