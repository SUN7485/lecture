// Stress matrix over the hosted pipeline (the product path), measuring rather
// than asserting: it is a survey, and its report is what the next fix reads.
//
//  PDF inputs : convert -> deck HTML  (pages, objects, ms, U+FFFD, word recall
//               against MuPDF's own text) -> PPTX (slide parts, RTL paragraphs
//               with no Arabic, Arabic paragraphs without RTL) -> PDF (pages)
//  HTML inputs: open in the real editor -> slides found -> doctor (cards,
//               score) -> fix all (score after, ms) -> PDF export (pages)
//
// Usage: node test/stress/matrix.mjs [baseUrl] [chromiumExe]
// Corpus: test fixtures + .preview/corpus (build-corpus.mjs) + any PDF listed
// in .preview/stress-extra.txt (one path per line, local only, never committed).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');
const AdmZip = require('adm-zip');
const mupdf = await import('mupdf');

const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const EXE = process.argv[3] || process.env.CHROMIUM_PATH || undefined;
const CORPUS = path.join(ROOT, '.preview', 'corpus');
const AR = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const ONLY = process.env.STRESS_ONLY ? new RegExp(process.env.STRESS_ONLY, 'i') : null;

const pdfs = [path.join(ROOT, 'test', 'fixtures', 'lecture.pdf'),
  ...fs.readdirSync(CORPUS).filter((f) => f.endsWith('.pdf')).map((f) => path.join(CORPUS, f))];
const extra = path.join(ROOT, '.preview', 'stress-extra.txt');
if (fs.existsSync(extra)) pdfs.push(...fs.readFileSync(extra, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((p) => p && fs.existsSync(p)));
const htmls = [
  ...['test/fixtures/bidi-deck.html', 'test/fixtures/calibration-deck.html', 'test/fixtures/mini-deck.html',
    'test/fixtures/source-bnb.html', 'test-fixtures/industrial-ops-wk1.html', 'test-fixtures/fenced-quirks.html',
    'Chp1-Lec1-2.html', '2.html'].map((p) => path.join(ROOT, p)),
  ...fs.readdirSync(path.join(ROOT, 'web', 'templates')).map((f) => path.join(ROOT, 'web', 'templates', f)),
  ...fs.readdirSync(CORPUS).filter((f) => f.endsWith('.html')).map((f) => path.join(CORPUS, f))
].filter((p) => !ONLY || ONLY.test(p));

const words = (s) => (s.normalize('NFKC').replace(/[ً-ْـ]/g, '').match(/[\p{L}\p{N}]+/gu) || []);
function recall(truthText, gotText) {
  const bag = new Map();
  for (const w of words(gotText)) bag.set(w, (bag.get(w) || 0) + 1);
  const truth = words(truthText);
  let hit = 0;
  for (const w of truth) { const n = bag.get(w); if (n) { hit++; bag.set(w, n - 1); } }
  return truth.length ? hit / truth.length : 1;
}
function pdfText(buf) {
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  let t = '';
  for (let i = 0; i < doc.countPages(); i++) t += doc.loadPage(i).toStructuredText('preserve-whitespace').asText() + '\n';
  return { pages: doc.countPages(), text: t };
}
function pptxAudit(buf) {
  const zip = new AdmZip(buf);
  const slides = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
  let paras = 0, rtlNoArabic = 0, arabicNoRtl = 0, arabicRuns = 0, arabicRunsNoCs = 0, langAr = 0;
  for (const e of slides) {
    const xml = e.getData().toString('utf8');
    for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []) {
      const text = (p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join('');
      if (!text.trim()) continue;
      paras++;
      const rtl = /<a:pPr[^>]*\brtl="1"/.test(p);
      const hasAr = AR.test(text);
      if (rtl && !hasAr) rtlNoArabic++;
      if (hasAr && !rtl) arabicNoRtl++;
      for (const r of p.match(/<a:r>[\s\S]*?<\/a:r>/g) || []) {
        const rt = (r.match(/<a:t>([^<]*)<\/a:t>/) || [])[1] || '';
        if (!AR.test(rt)) continue;
        arabicRuns++;
        if (!/<a:cs\b/.test(r)) arabicRunsNoCs++;
        if (/lang="ar/.test(r)) langAr++;
      }
    }
  }
  return { slides: slides.length, paras, rtlNoArabic, arabicNoRtl, arabicRuns, arabicRunsNoCs, langAr };
}

const rows = [];
const browser = await chromium.launch({ executablePath: EXE });
const t = () => Date.now();

// ---------------- PDF inputs ----------------
for (const file of pdfs.filter((p) => !ONLY || ONLY.test(p))) {
  const row = { kind: 'pdf', name: path.basename(file) };
  try {
    const buf = fs.readFileSync(file);
    const truth = pdfText(buf);
    row.pages = truth.pages;
    let t0 = t();
    const c = await fetch(BASE + '/api/convert', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/pdf', 'x-file-name': 'in.pdf' }, body: buf });
    const cookie = c.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
    const out = await c.json();
    if (!c.ok) { row.convert = `HTTP ${c.status}: ${out.error}`; rows.push(row); continue; }
    row.convertMs = t() - t0;
    row.slides = (out.html.match(/class="slide"/g) || []).length;
    row.objects = out.stats.objects;
    const text = out.html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
    row.fffd = (out.html.match(/�/g) || []).length;
    row.recall = +recall(truth.text, text).toFixed(4);
    t0 = t();
    const p = await fetch(BASE + '/api/export/pptx', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie }, body: JSON.stringify({ modelId: out.modelId, name: 'x' }) });
    if (p.ok) { row.pptxMs = t() - t0; Object.assign(row, { pptx: pptxAudit(Buffer.from(await p.arrayBuffer())) }); }
    else row.pptx = `HTTP ${p.status}: ${(await p.json()).error}`;
    t0 = t();
    const d = await fetch(BASE + '/api/export/pdf', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie }, body: JSON.stringify({ html: out.html, name: 'x' }) });
    if (d.ok) { row.pdfMs = t() - t0; row.pdfPages = pdfText(Buffer.from(await d.arrayBuffer())).pages; }
    else row.pdfOut = `HTTP ${d.status}`;
  } catch (e) { row.error = e.message; }
  rows.push(row);
  console.log(JSON.stringify(row));
}

// ---------------- HTML inputs (through the real editor) ----------------
for (const file of htmls) {
  const row = { kind: 'html', name: path.relative(ROOT, file).replace(/\\/g, '/') };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(BASE + '/editor', { waitUntil: 'networkidle' });
    let t0 = t();
    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(() => window.__editor && window.__editor.doc && /جاهز|حُوّل|Ready/.test(document.getElementById('status').textContent), null, { timeout: 90000 });
    row.openMs = t() - t0;
    const before = await page.evaluate(() => {
      const ed = window.__editor;
      const iss = window.SlideDoctor.analyze(ed);
      const cards = window.SlideDoctor.aggregate(iss);
      const errs = cards.filter((c) => c.severity === 'error').length;
      return { slides: ed.slides().length, cards: cards.length, rules: [...new Set(cards.map((c) => c.ruleId))].sort(),
               score: Math.max(0, 100 - 12 * errs - 4 * (cards.length - errs)) };
    });
    Object.assign(row, { slides: before.slides, cards: before.cards, score: before.score, rules: before.rules.join(',') });
    if (before.cards) {
      await page.click('#btn-doctor');
      await page.waitForSelector('.dr-fixall', { timeout: 10000 });
      t0 = t();
      await page.click('.dr-fixall');
      await page.waitForFunction(() => /صلحت|لا توجد/.test(document.getElementById('status').textContent), null, { timeout: 120000 }).catch(() => {});
      row.fixMs = t() - t0;
      const after = await page.evaluate(() => {
        const cards = window.SlideDoctor.aggregate(window.SlideDoctor.analyze(window.__editor));
        const errs = cards.filter((c) => c.severity === 'error').length;
        return { cards: cards.length, score: Math.max(0, 100 - 12 * errs - 4 * (cards.length - errs)), rules: [...new Set(cards.map((c) => c.ruleId))].sort().join(',') };
      });
      row.scoreAfter = after.score; row.left = after.rules;
    }
    const html = await page.evaluate(() => window.__editor.getCleanHtml());
    t0 = t();
    const d = await fetch(BASE + '/api/export/pdf', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ html, name: 'x' }) });
    if (d.ok) { row.pdfMs = t() - t0; row.pdfPages = pdfText(Buffer.from(await d.arrayBuffer())).pages; }
    else row.pdfOut = `HTTP ${d.status}: ${(await d.text()).slice(0, 120)}`;
  } catch (e) { row.error = e.message.split('\n')[0]; }
  await page.close();
  rows.push(row);
  console.log(JSON.stringify(row));
}
await browser.close();

fs.writeFileSync(path.join(ROOT, '.preview', 'stress-report.json'), JSON.stringify(rows, null, 2));
console.log(`\n${rows.length} rows -> .preview/stress-report.json`);
