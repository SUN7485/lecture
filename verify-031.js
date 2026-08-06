// Verifies PDF export in the REAL Electron app, on a REAL deck: every slide
// must become exactly ONE page, at the deck's own width, with nothing cut.
//
// Run: node verify-031.js [path-to-deck.html]
//
// The bug this pins down: detectSlides() used to require every slide to be the
// same HEIGHT. A deck authored with `min-height` lets each slide grow to its
// content (Chp5-Lec35 measured 680..1007px), so detection failed, no pageSize
// was passed to printToPDF, and the export silently fell back to Letter
// portrait — where a 1000px slide loses ~130px off each side. The user saw
// titles clipped on both edges.
//
// Measured the only way that can't lie: the PDF's own /MediaBox, its page
// count, and the drawn-text operators inside each page's content stream.
const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const DECK = process.argv[2] || path.resolve('2.html');
const OUT = path.join(require('os').tmpdir(), `lve-verify031-${Date.now()}.pdf`);

// ---- PDF readers: page boxes, and text volume per page in document order ----
function readPdf(file) {
  const buf = fs.readFileSync(file);
  const s = buf.toString('latin1');
  const objs = {};
  let m;
  const objRe = /(\d+)\s+0\s+obj\b/g;
  while ((m = objRe.exec(s))) {
    const end = s.indexOf('endobj', m.index);
    objs[+m[1]] = { start: m.index, end: end < 0 ? s.length : end };
  }
  const streamText = (num) => {
    const o = objs[num];
    if (!o) return null;
    const st = s.indexOf('stream', o.start);
    if (st < 0 || st > o.end) return null;
    let d = st + 6;
    if (buf[d] === 13) d++;
    if (buf[d] === 10) d++;
    const e = s.indexOf('endstream', d);
    try { return zlib.inflateSync(buf.slice(d, e)).toString('latin1'); }
    catch (_) { return buf.slice(d, e).toString('latin1'); }
  };
  const pages = [];
  const pageRe = /\/Type\s*\/Page[^s]/g;
  while ((m = pageRe.exec(s))) {
    const body = s.slice(m.index, s.indexOf('endobj', m.index));
    const c = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const txt = c ? streamText(+c[1]) : null;
    pages.push({ textOps: txt ? (txt.match(/\bT[Jj]\b/g) || []).length : -1 });
  }
  const boxes = [...new Set((s.match(/\/MediaBox\s*\[[^\]]*\]/g) || []))];
  return { pages, boxes, bytes: buf.length };
}

(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: { ...process.env, LVE_OPEN: path.resolve(DECK), LVE_EXPORT_PATH: OUT },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.body.children.length > 2,
    null, { timeout: 60000 });
  await win.waitForTimeout(2500);

  // What the deck actually is, measured live: how many slides, how much their
  // heights vary (the condition that used to break detection), and whether any
  // slide is empty in the SOURCE (so an empty page is attributed correctly).
  const deck = await win.evaluate(() => {
    const ed = window.__editor;
    const els = Array.from(ed.doc.body.children).filter(el =>
      el.nodeType === 1 && !/^ve-/.test(el.className) &&
      el.offsetWidth > 400 && el.offsetHeight > 250);
    return {
      slides: els.length,
      widths: [...new Set(els.map(e => e.offsetWidth))],
      heights: els.map(e => e.offsetHeight),
      emptyInSource: els.filter(e => e.textContent.replace(/\s+/g, '').length < 120).length,
    };
  });

  await win.click('#btn-export');
  await win.waitForFunction(() => /Exported PDF|failed/.test(document.body.innerText),
    null, { timeout: 180000 });
  const status = await win.evaluate(() => {
    const m = document.body.innerText.match(/(Exported PDF[^\n]*|Export failed[^\n]*)/);
    return m ? m[1] : '(no status)';
  });
  await app.close();

  const pdf = readPdf(OUT);
  const hs = deck.heights.slice().sort((a, b) => a - b);
  const box = pdf.boxes[0] ? pdf.boxes[0].match(/[\d.]+/g).map(Number) : [0, 0, 0, 0];
  const pageW = Math.round(box[2] / 72 * 96), pageH = Math.round(box[3] / 72 * 96);
  const blank = pdf.pages.filter(p => p.textOps <= 0).length;

  console.log('deck:', DECK);
  console.log('  slides:', deck.slides, '| widths:', deck.widths.join(','),
    '| heights:', hs[0] + '..' + hs[hs.length - 1],
    hs[0] === hs[hs.length - 1] ? '(uniform)' : '(VARIES — the case that used to break)');
  console.log('  export:', status);
  console.log('  pages:', pdf.pages.length, '| page size:', pageW + 'x' + pageH + 'px',
    '| distinct MediaBoxes:', pdf.boxes.length, '|', pdf.bytes, 'bytes');
  console.log('  text ops per page:', pdf.pages.map(p => p.textOps).join(', '));

  const onePagePerSlide = pdf.pages.length === deck.slides;
  const uniformPage = pdf.boxes.length === 1;
  // The page must be as wide as the slides themselves — the clipping bug was
  // exactly a page narrower than the deck.
  const fullWidth = Math.abs(pageW - deck.widths[0]) <= 2;
  // Tall enough for the tallest slide, so nothing is cut (unless the 1.5x cap
  // bit, in which case that slide was scaled to fit instead).
  const tallEnough = pageH >= Math.min(hs[hs.length - 1], Math.round(hs[0] * 1.5)) - 2;
  const noBlanks = blank <= deck.emptyInSource;

  const pass = onePagePerSlide && uniformPage && fullWidth && tallEnough && noBlanks;
  console.log('  one page per slide:', onePagePerSlide, '| one page size:', uniformPage,
    '| page as wide as slides:', fullWidth, '| tall enough:', tallEnough,
    '| blank pages:', blank, '(empty in source:', deck.emptyInSource + ')');
  console.log(pass ? 'PASS 031' : 'FAIL 031');
  fs.unlink(OUT, () => {});
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('FAIL 031 (crash):', e && e.stack || e); process.exitCode = 1; });
