'use strict';

// The hosted surface is the part of this system the internet can reach, so its
// REFUSALS matter more than its features. Each assertion below corresponds to a
// way the local studio (engine/src/server.js) would have been unsafe to expose.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, before, after } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8123 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { origin: BASE };
const LECTURE = path.join(ROOT, 'test', 'fixtures', 'lecture.pdf');

let child;

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SOURCE_URL: 'https://example.test/source',
      // The suite runs well over 10 conversions in its first minute; at the
      // production default the later tests were refused with 429 and failed
      // for a reason that has nothing to do with what they test.
      RATE_MAX_CONVERSIONS: '1000',
      RATE_MAX_EXPORTS: '1000',
      ELECTRON_RUN_AS_NODE: undefined
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become ready');
});

after(() => { if (child) child.kill(); });

test('refuses to start without SOURCE_URL (AGPL s13 is not optional)', async () => {
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT + 900), SOURCE_URL: '', ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, err }));
  });
  assert.notEqual(out.code, 0, 'server started without a source offer');
  assert.match(out.err, /SOURCE_URL is required/);
});

test('health, readiness and the source offer', async () => {
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200);
  const ready = await (await fetch(`${BASE}/readyz`)).json();
  assert.equal(ready.ready, true);

  const src = await fetch(`${BASE}/source`, { redirect: 'manual' });
  assert.equal(src.status, 302);
  assert.equal(src.headers.get('location'), 'https://example.test/source');
});

test('rejects cross-origin and origin-less writes (CSRF)', async () => {
  const noOrigin = await fetch(`${BASE}/api/convert`, { method: 'POST', body: 'x' });
  assert.equal(noOrigin.status, 403, 'a write with no Origin was accepted');

  const foreign = await fetch(`${BASE}/api/convert`, {
    method: 'POST', headers: { origin: 'https://evil.test' }, body: 'x'
  });
  assert.equal(foreign.status, 403, 'a cross-origin write was accepted');
});

test('rejects non-PDF uploads by magic number, not extension', async () => {
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'x-file-name': 'totally.pdf' },
    body: 'MZ\u0090\u0000this is a windows executable'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NOT_PDF');
});

test('the filesystem is not addressable', async () => {
  // The local studio has /api/browse and an ALLOWED_ROOTS list. The hosted
  // surface must have neither, and must not be escapable through static paths.
  const browse = await fetch(`${BASE}/api/browse?dir=C:/`);
  assert.notEqual(browse.status, 200, '/api/browse is reachable on the hosted surface');

  for (const attempt of ['/../server/config.js', '/%2e%2e%2fserver%2fconfig.js', '/../../etc/passwd']) {
    const r = await fetch(BASE + attempt);
    assert.ok(r.status === 403 || r.status === 404, `${attempt} returned ${r.status}`);
    const body = await r.text();
    assert.ok(!body.includes('SOURCE_URL is required'), `${attempt} leaked server source`);
  }
});

test('sends the security headers a public service needs', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // Same-origin framing is needed for template previews; foreign framing is not.
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'(;|$)/);
  assert.match(r.headers.get('content-security-policy'), /object-src 'none'/);
  // Stale JS after a deploy is an invisible outage; assets must revalidate.
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const asset = await fetch(`${BASE}/app.js`);
  assert.equal(asset.headers.get('cache-control'), 'no-cache');
  assert.ok(asset.headers.get('etag'), 'no etag to revalidate against');
});

test('converts a real lecture and exports both formats', { timeout: 180000 }, async () => {
  assert.equal(fs.existsSync(LECTURE), true, `missing fixture: ${LECTURE}`);

  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf', 'x-file-name': 'lecture.pdf' },
    body: fs.readFileSync(LECTURE)
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().join('; ');
  const out = await res.json();

  assert.equal(out.stats.pages, 21);
  assert.ok(out.stats.objects > 500, `only ${out.stats.objects} objects`);
  assert.equal((out.html.match(/class="slide"/g) || []).length, 21);
  assert.equal((out.html.match(/\uFFFD/g) || []).length, 0, 'U+FFFD in reconstructed deck');
  assert.ok((out.html.match(/[\u0600-\u06FF]/g) || []).length > 5000, 'Arabic did not survive');

  // PPTX — must be a real zip with one part per slide.
  const pptx = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ modelId: out.modelId, name: 'lecture' })
  });
  assert.equal(pptx.status, 200);
  const pptxBuf = Buffer.from(await pptx.arrayBuffer());
  assert.equal(pptxBuf.subarray(0, 2).toString('latin1'), 'PK');
  const AdmZip = require('adm-zip');
  const names = new AdmZip(pptxBuf).getEntries().map((e) => e.entryName);
  assert.equal(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 21);

  // PDF — page geometry must match the SOURCE, not be silently rescaled.
  const pdf = await fetch(`${BASE}/api/export/pdf`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ html: out.html, name: 'lecture' })
  });
  assert.equal(pdf.status, 200);
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 4).toString('latin1'), '%PDF');
  console.log(`convert ${out.stats.pages}p/${out.stats.objects}obj in ${out.stats.ms}ms · ` +
    `pptx ${pptxBuf.length}B · pdf ${pdfBuf.length}B`);
});

test('one session cannot export another session\'s document', async () => {
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf' },
    body: fs.readFileSync(LECTURE)
  });
  const { modelId } = await res.json();

  // Same id, no cookie: a different browser entirely.
  const stolen = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ modelId })
  });
  assert.equal(stolen.status, 410, 'a foreign session was handed the model');
});

test('broken PDFs are refused with a code and an Arabic message, never "rebuilt"', { timeout: 120000 }, async () => {
  // A password-protected PDF once imported as "21 scanned pages", and a
  // half-finished download as a successful rebuild of zero pages.
  const mupdf = await import(require('node:url').pathToFileURL(path.join(ROOT, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href);
  const src = fs.readFileSync(LECTURE);
  const locked = Buffer.from(mupdf.Document.openDocument(src, 'application/pdf').asPDF()
    .saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner').asUint8Array());
  const cases = [
    ['password', locked, 422, 'PDF_ENCRYPTED'],
    ['truncated', src.subarray(0, Math.floor(src.length * 0.55)), 422, 'PDF_DAMAGED'],
    ['empty', Buffer.alloc(0), 400, 'NOT_PDF']
  ];
  for (const [name, body, status, code] of cases) {
    const r = await fetch(`${BASE}/api/convert`, {
      method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/pdf' }, body
    });
    const out = await r.json();
    assert.equal(r.status, status, `${name}: HTTP ${r.status}`);
    assert.equal(out.code, code, `${name}: code ${out.code}`);
    assert.match(out.error, /[؀-ۿ]/, `${name}: the message is not Arabic: ${out.error}`);
  }
});

test('a deck mixing slide sizes exports one PDF page per slide', { timeout: 120000 }, async () => {
  // A 16:9 or A4 slide in a 950x650 deck used to spill onto extra pages.
  const s = (w, h, t) => `<div class="slide" style="width:${w}px;height:${h}px;background:#fff"><h1>${t}</h1></div>`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body>` +
    s(950, 650, 'أولى') + s(1280, 720, 'ثانية') + s(794, 1123, 'ثالثة') + `</body></html>`;
  const r = await fetch(`${BASE}/api/export/pdf`, {
    method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ html })
  });
  assert.equal(r.status, 200);
  const mupdf = await import(require('node:url').pathToFileURL(path.join(ROOT, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href);
  const pages = mupdf.Document.openDocument(Buffer.from(await r.arrayBuffer()), 'application/pdf').countPages();
  assert.equal(pages, 3, `3 slides became ${pages} pages`);
});

test('an HTML deck (no imported PDF) exports as an editable PPTX', { timeout: 180000 }, async () => {
  // Before this existed the web PowerPoint button only worked for decks rebuilt
  // from a PDF; a template, an opened lecture or an AI-made deck could not
  // become PowerPoint at all on the hosted build.
  const html = fs.readFileSync(path.join(ROOT, 'web', 'templates', 'lesson-intro.html'), 'utf8');
  const slidesIn = (html.match(/<div class="slide[\s"]/g) || []).length;
  const res = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ html, name: 'template' })
  });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  const slides = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
  assert.equal(slides.length, slidesIn, `${slidesIn} slides in, ${slides.length} out`);
  const xml = slides.map((e) => e.getData().toString('utf8')).join('');
  assert.ok(/<a:t>[^<]*[؀-ۿ]/.test(xml), 'no native Arabic text runs — the deck was flattened');
  assert.ok(/<a:pPr[^>]*rtl="1"/.test(xml), 'Arabic paragraphs lost their RTL direction');
});

test('an edit made in the editor reaches the exported PPTX', { timeout: 180000 }, async () => {
  // The defect this locks: before engine/apply-edits.js existed, PPTX was
  // written from the stored model while PDF was rendered from the edited HTML,
  // so the same session produced two different documents and the PPTX silently
  // shipped the ORIGINAL text. Measured then: edit absent, original present.
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf', 'x-file-name': 'lecture.pdf' },
    body: fs.readFileSync(LECTURE)
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().join('; ');
  const out = await res.json();

  // Reconstruct what the browser collector sends: every object on the canvas.
  const strip = (f) => f.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const entries = [];
  const textRe = /<div class="obj text" data-id="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="obj|<\/div>)/g;
  let m;
  while ((m = textRe.exec(out.html))) entries.push({ id: m[1], text: strip(m[2]) });
  for (const om of out.html.matchAll(/<(?:div|img) class="obj (?:shape|image)" data-id="([^"]+)"/g)) {
    entries.push({ id: om[1] });
  }

  const NEEDLE = '\u0627\u0633\u062a\u0631\u0627\u062a\u064a\u062c\u064a\u0627\u062a'; // a word in the deck
  const EDIT = 'XXEDITEDXX';
  const hits = entries.filter((e) => e.text && e.text.includes(NEEDLE)).length;
  assert.ok(hits > 0, 'test word not present in the deck - fixture changed?');
  for (const e of entries) if (e.text) e.text = e.text.split(NEEDLE).join(EDIT);

  const pptx = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ modelId: out.modelId, name: 'edited', objects: entries })
  });
  assert.equal(pptx.status, 200);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(Buffer.from(await pptx.arrayBuffer()));
  const slideParts = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
  assert.equal(slideParts.length, 21, 'reconciliation changed the slide count');

  const xml = slideParts.map((e) => zip.readAsText(e.entryName)).join('');
  assert.ok(xml.includes(EDIT), 'the edit did NOT reach the PPTX');
  assert.ok(!xml.includes(NEEDLE), 'the ORIGINAL text is still in the PPTX');
  console.log(`edit round-trip: ${entries.length} objects reported, ${hits} edited, ${slideParts.length} slides intact`);
});

test('a deck exported twice is not corrupted by the first export', async () => {
  // The stored model is the RECONSTRUCTION; each export must be
  // reconstruction + current canvas, never a compounding mutation.
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf' },
    body: fs.readFileSync(LECTURE)
  });
  const cookie = res.headers.getSetCookie().join('; ');
  const out = await res.json();

  const ids = [...out.html.matchAll(/data-id="([^"]+)"/g)].map((m) => ({ id: m[1] }));
  const once = async () => {
    const r = await fetch(`${BASE}/api/export/pptx`, {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ modelId: out.modelId, objects: ids })
    });
    assert.equal(r.status, 200);
    return Buffer.from(await r.arrayBuffer()).length;
  };
  const a = await once();
  const b = await once();
  // Byte length is a proxy; what matters is that the second export did not
  // find a model already stripped by the first.
  assert.ok(Math.abs(a - b) < 2048, `exports diverged: ${a} then ${b} bytes`);
});

// ---------------------------------------------------------------------------
// Security regressions. Each of these FAILED against the server as first built.
// ---------------------------------------------------------------------------

test('a conversion does not freeze the server for everyone else', { timeout: 180000 }, async () => {
  // modelFromPdf is synchronous. Run on the request thread it blocked the event
  // loop for its whole duration: /healthz measured 51ms idle and 2847ms during
  // ONE ordinary 21-page conversion. That is a denial of service triggered by a
  // legitimate request, and it also starves the container healthcheck, so the
  // orchestrator restarts a server that is merely busy. The work now runs in a
  // worker pool.
  const idleStart = Date.now();
  await fetch(`${BASE}/healthz`);
  const idle = Date.now() - idleStart;

  const convert = fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf' },
    body: fs.readFileSync(LECTURE)
  });
  await new Promise((r) => setTimeout(r, 150)); // let it get going

  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    samples.push(Date.now() - t);
  }
  assert.equal((await convert).status, 200);

  const worst = Math.max(...samples);
  assert.ok(worst < 500,
    `event loop blocked during conversion: healthz ${worst}ms (idle ${idle}ms) — samples ${samples.join(',')}`);
});

test('an oversized PDF is refused before it is extracted', async () => {
  // The limit must be enforced on the page count read from the trailer, not
  // after extraction — a budget checked afterwards has already paid the cost.
  const pages = 250;
  const objs = [];
  const kids = [];
  for (let i = 0; i < pages; i++) kids.push(`${4 + i * 2} 0 R`);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pages; i++) {
    const st = `BT /F1 12 Tf 40 100 Td (P${i}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${st.length} >>\nstream\n${st}\nendstream`;
  }
  const max = 3 + pages * 2;
  let pdf = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i <= max; i++) { off[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const started = Date.now();
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/pdf' },
    body: Buffer.from(pdf, 'latin1')
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, 'TOO_MANY_PAGES');
  assert.match(body.error, /250 صفحة/, `the user is not told the page count: ${body.error}`);
  assert.ok(Date.now() - started < 5000, 'the limit was applied after doing the work');
});

test('an oversized edit payload is refused instead of occupying the service', async () => {
  // Measured unbounded: 20k synthesized objects took 8.9s and 60k took 124s.
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/pdf' }, body: fs.readFileSync(LECTURE)
  });
  const cookie = res.headers.getSetCookie().join('; ');
  const { modelId } = await res.json();

  const flood = [];
  for (let i = 0; i < 60000; i++) {
    flood.push({ isNew: true, page: 0, kind: 'text', text: 'X'.repeat(20), bbox: { x: 1, y: 1, w: 10, h: 10 } });
  }
  const started = Date.now();
  const r = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ modelId, objects: flood })
  });
  assert.equal(r.status, 413);
  assert.ok(Date.now() - started < 15000, 'the flood was processed before being refused');
});

test('user text cannot inject raw markup into the PPTX', async () => {
  const res = await fetch(`${BASE}/api/convert`, {
    method: 'POST', headers: { ...ORIGIN, 'content-type': 'application/pdf' }, body: fs.readFileSync(LECTURE)
  });
  const cookie = res.headers.getSetCookie().join('; ');
  const out = await res.json();
  const textIds = [...out.html.matchAll(/<div class="obj text" data-id="([^"]+)"/g)].map((m) => m[1]);
  const allIds = [...out.html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);

  const payload = '</a:t></a:r><a:r><a:t>INJECTED</a:t></a:r><a:r><a:t>';
  const objects = allIds.map((id) => (id === textIds[0] ? { id, text: payload } : { id }));
  const r = await fetch(`${BASE}/api/export/pptx`, {
    method: 'POST',
    headers: { ...ORIGIN, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ modelId: out.modelId, objects })
  });
  assert.equal(r.status, 200);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(Buffer.from(await r.arrayBuffer()));
  const xml = zip.getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .map((e) => zip.readAsText(e.entryName)).join('');
  assert.ok(!xml.includes('</a:t></a:r><a:r><a:t>INJECTED'), 'raw OOXML injection landed');
  assert.ok(xml.includes('&lt;/a:t&gt;'), 'the payload was not escaped');
});

test('a crafted deck cannot reach the filesystem, the network, or cloud metadata', { timeout: 180000 }, async () => {
  // render-pdf.js aborts every request whose scheme is not data:/blob:/about:,
  // so a deck cannot be used as an SSRF/LFI primitive against the host. On a
  // cloud VM the metadata endpoint is the prize.
  const attempts = {
    lfi: '<iframe width=600 height=400 src="file:///C:/Windows/win.ini"></iframe><iframe width=600 height=400 src="file:///etc/passwd"></iframe>',
    metadata: '<iframe width=600 height=400 src="http://169.254.169.254/latest/meta-data/"></iframe>',
    internal: `<iframe width=600 height=400 src="${BASE}/readyz"></iframe>`
  };
  for (const [name, body] of Object.entries(attempts)) {
    const html = `<html><body><div class="slide" style="width:600px;height:400px">${body}</div></body></html>`;
    const r = await fetch(`${BASE}/api/export/pdf`, {
      method: 'POST',
      headers: { ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ html, name: 'p' })
    });
    assert.equal(r.status, 200);
    const text = Buffer.from(await r.arrayBuffer()).toString('latin1');
    assert.ok(!/16-bit app support|\[fonts\]|root:x:|instance-id|ami-id|"ready"/.test(text),
      `${name}: the render reached something it should not have`);
  }
});

test('the landing page is served at / and hands every job to the editor', async () => {
  const landing = await fetch(`${BASE}/`);
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get('cache-control'), 'no-store');
  const html = await landing.text();

  // The three jobs, and each must point at a flow the editor actually knows.
  const flows = [...html.matchAll(/\/editor\?flow=([a-z-]+)/g)].map((m) => m[1]);
  const KNOWN = ['pdf-pptx', 'pdf-pdf', 'html-edit', 'html-pdf'];
  assert.ok(flows.length >= 3, `landing offers ${flows.length} flows`);
  for (const f of flows) assert.ok(KNOWN.includes(f), `landing links unknown flow "${f}"`);

  // The other half of that contract lives in the editor.
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const table = app.slice(app.indexOf('const FLOW ='), app.indexOf('const FLOW =') + 700);
  for (const f of new Set(flows)) {
    assert.ok(table.includes(`'${f}'`), `the editor has no handler for flow "${f}"`);
  }

  const editor = await fetch(`${BASE}/editor`);
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /btn-export-pptx/);
});

test('the landing page does not claim files are never uploaded', async () => {
  // It used to say "لا يُرفع أي ملف لأي خادم" — no file is uploaded to any
  // server. That stopped being true the moment PDF rebuilding existed, and a
  // false privacy claim is not a cosmetic bug.
  const html = await (await fetch(`${BASE}/`)).text();
  // Every phrasing of "nothing is uploaded" the page has used. The first
  // version of this test checked only one, and a second section kept saying
  // "your files never leave your device. Ever." with a "no uploads" badge.
  for (const claim of [/لا\s*يُرفع\s*أي\s*ملف/, /لا\s*تغادر\s*جهازك/, /بلا\s*رفع/, /لا\s*رفع/]) {
    assert.ok(!claim.test(html), `the landing page still promises that nothing is ever uploaded (${claim})`);
  }
  assert.match(html, /\/source/, 'the AGPL source offer is not linked (section 13)');
});
