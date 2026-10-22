// Runs .preview/strange through the hosted product path and records what a
// USER would experience: the message they see, what they get, and whether a
// save -> reopen round trip changes the deck. Survey, not assertions.
// Usage: node test/stress/strange-run.mjs [baseUrl] [chromiumExe]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');
const AdmZip = require('adm-zip');
const mupdf = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href);
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const DIR = path.join(ROOT, '.preview', 'strange');
const ONLY = process.env.STRESS_ONLY ? new RegExp(process.env.STRESS_ONLY, 'i') : null;
const files = fs.readdirSync(DIR).filter((f) => !ONLY || ONLY.test(f)).sort();
const pages = (buf) => { try { return mupdf.Document.openDocument(buf, 'application/pdf').countPages(); } catch (e) { return 'unreadable'; } };
const pptxSlides = (buf) => { try { return new AdmZip(buf).getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).length; } catch (e) { return 'not a zip'; } };
const post = (route, body, headers, cookie) => fetch(BASE + route, { method: 'POST', headers: { origin: BASE, ...headers, ...(cookie ? { cookie } : {}) }, body });

const browser = await chromium.launch({ executablePath: process.argv[3] || process.env.CHROMIUM_PATH || undefined });
const rows = [];
for (const name of files) {
  const file = path.join(DIR, name);
  const row = { name };
  try {
    if (name.endsWith('.pdf')) {
      // Through the real browser UI, so the message is the one a user reads.
      const page = await browser.newPage();
      await page.goto(BASE + '/editor?flow=pdf-pptx', { waitUntil: 'networkidle' });
      const t0 = Date.now();
      await page.setInputFiles('#pdf-input', file);
      await page.waitForFunction(() => /تمت|تعذّر|حجم|ممسوحة|صفحة/.test(document.getElementById('status').textContent) &&
        !/جارٍ/.test(document.getElementById('status').textContent), null, { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(400);
      row.ms = Date.now() - t0;
      row.message = await page.evaluate(() => document.getElementById('status').textContent);
      row.slides = await page.evaluate(() => (window.__editor ? window.__editor.slides().length : 0));
      if (row.slides) {
        const html = await page.evaluate(() => window.__editor.getCleanHtml());
        row.fffd = (html.match(/�/g) || []).length;
        const d = await post('/api/export/pdf', JSON.stringify({ html }), { 'content-type': 'application/json' });
        row.pdfOut = d.ok ? pages(Buffer.from(await d.arrayBuffer())) : 'HTTP ' + d.status;
      }
      await page.close();
    } else {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
      await page.goto(BASE + '/editor', { waitUntil: 'networkidle' });
      const t0 = Date.now();
      await page.setInputFiles('#file-input', file);
      await page.waitForFunction(() => window.__editor && /جاهز|حُوّل|تعذّر/.test(document.getElementById('status').textContent), null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(500);
      row.ms = Date.now() - t0;
      row.message = await page.evaluate(() => document.getElementById('status').textContent);
      const info = await page.evaluate(() => {
        const ed = window.__editor;
        if (!ed) return { slides: 0 };
        const cards = window.SlideDoctor.aggregate(window.SlideDoctor.analyze(ed));
        const errs = cards.filter((c) => c.severity === 'error').length;
        return { slides: ed.slides().length, score: Math.max(0, 100 - 12 * errs - 4 * (cards.length - errs)),
                 rules: [...new Set(cards.map((c) => c.ruleId))].join(','), mojibake: /Ø|Ù|Ã|Â/.test(ed.doc.body.textContent) };
      });
      Object.assign(row, info);
      if (info.slides) {
        const html = await page.evaluate(() => window.__editor.getCleanHtml());
        row.savedKB = Math.round(html.length / 1024);
        // round trip: open what Save would write, count again
        const again = path.join(DIR, '..', 'strange-roundtrip.html');
        fs.writeFileSync(again, html, 'utf8');
        await page.setInputFiles('#file-input', again);
        await page.waitForTimeout(1500);
        row.slidesAfterReopen = await page.evaluate(() => window.__editor.slides().length);
        const d = await post('/api/export/pdf', JSON.stringify({ html }), { 'content-type': 'application/json' });
        row.pdfOut = d.ok ? pages(Buffer.from(await d.arrayBuffer())) : 'HTTP ' + d.status + ' ' + (await d.text()).slice(0, 80);
        const p = await post('/api/export/pptx', JSON.stringify({ html }), { 'content-type': 'application/json' });
        row.pptxOut = p.ok ? pptxSlides(Buffer.from(await p.arrayBuffer())) : 'HTTP ' + p.status + ' ' + (await p.text()).slice(0, 80);
      }
      if (errors.length) row.pageErrors = errors.slice(0, 2);
      await page.close();
    }
  } catch (e) { row.error = e.message.split('\n')[0].slice(0, 160); }
  rows.push(row);
  console.log(JSON.stringify(row));
}
await browser.close();
fs.writeFileSync(path.join(ROOT, '.preview', 'strange-report.json'), JSON.stringify(rows, null, 2));
