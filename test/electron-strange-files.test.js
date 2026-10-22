'use strict';

// Files users really have that are not tidy UTF-8 decks: an old Arabic file
// in windows-1256, a web article, a plain-text file, an empty file, and a
// deck that builds its slides with JavaScript. Opened through the shipping
// open path (LVE_OPEN -> main.js readHtml -> renderer), each must either
// become slides or say plainly why not — never «جاهز» over an empty canvas.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { launchLve } = require('./support/launch-electron');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-strange-'));
const file = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };

function cp1256(text) {
  const dec = new TextDecoder('windows-1256');
  const map = new Map();
  for (let b = 0x80; b < 0x100; b++) map.set(dec.decode(Uint8Array.of(b)), b);
  return Buffer.from([...text].map((ch) => (ch.codePointAt(0) < 0x80 ? ch.codePointAt(0) : map.get(ch))));
}

async function open(p) {
  const { app, page } = await launchLve({ open: p });
  await page.waitForFunction(() => window.__editor, null, { timeout: 30000 });
  await page.waitForFunction(() => !/^\s*$|جارٍ/.test(document.getElementById('status').textContent), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    slides: window.__editor.slides().length,
    status: document.getElementById('status').textContent,
    text: window.__editor.doc.body.textContent.replace(/\s+/g, ' ').trim()
  }));
  return { app, page, ...r };
}

test('an Arabic file saved as windows-1256 opens readable', { timeout: 90000 }, async () => {
  const p = file('old.html', cp1256('<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1256"></head><body>' +
    '<div class="slide" style="width:950px;height:650px"><h1>محاضرة محفوظة بترميز قديم</h1></div></body></html>'));
  const r = await open(p);
  try {
    assert.ok(r.text.includes('محاضرة محفوظة بترميز قديم'), `garbled: ${r.text.slice(0, 80)}`);
    assert.ok(!/�/.test(r.text));
  } finally { await r.app.close(); }
});

test('a web article becomes slides at its headings', { timeout: 90000 }, async () => {
  const body = Array.from({ length: 5 }, (_, i) => `<h2>القسم ${i + 1}</h2><p>${'فقرة عن إدارة الجودة الشاملة وتحسين العمليات. '.repeat(10)}</p>`).join('');
  const r = await open(file('article.html', `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>مقال</title></head><body><nav>روابط</nav><main><article><h1>إدارة الجودة</h1>${body}</article></main><footer>©</footer></body></html>`));
  try {
    assert.ok(r.slides >= 5, `${r.slides} slides`);
    assert.match(r.status, /حُوّل المقال/);
    assert.ok(!r.text.includes('روابط'), 'site navigation came along as content');
  } finally { await r.app.close(); }
});

test('plain text becomes slides; empty and script-built files say why there is nothing', { timeout: 120000 }, async () => {
  const cases = [
    ['notes.html', 'السطر الأول من الملاحظات\nالسطر الثاني\nالسطر الثالث', (r) => { assert.ok(r.slides >= 1); assert.match(r.status, /حُوّل النص/); }],
    ['empty.html', '', (r) => { assert.equal(r.slides, 0); assert.match(r.status, /فارغ/); }],
    ['scripted.html', '<!doctype html><html><body><div id="root"></div><script>document.getElementById("root").innerHTML="<div class=slide>x</div>"</script></body></html>',
      (r) => { assert.match(r.status, /جافاسكربت/); }]
  ];
  for (const [name, content, check] of cases) {
    const r = await open(file(name, content));
    try { check(r); } finally { await r.app.close(); }
  }
});
