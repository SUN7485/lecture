'use strict';

// Arabic/English correctness in the real app: the doctor's typography rules
// (22-26), the "fix all never deletes slides" guarantee, and the deck-shape
// sniffer that turns AI-made one-slide-at-a-time decks into real slides.
// Each deck is opened through the shipping open path (LVE_OPEN hook).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

function deckFile(name, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-ar-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

const slide = (h, b) => `<div class="slide" style="width:950px;height:650px;padding:40px 60px;box-sizing:border-box;position:relative;overflow:hidden;background:#fff"><h1>${h}</h1>${b}</div>`;
const page = (attrs, slides) => `<!doctype html><html ${attrs}><head><meta charset="utf-8"><style>body{margin:0;font-family:Tahoma,sans-serif}</style></head><body>${slides.join('')}</body></html>`;
const LONG_AR = 'سطر عربي طويل بما يكفي لأن يلتف على أكثر من سطر واحد داخل الشريحة، وفيه حركاتٌ وتشكيلٌ تحتاج إلى مسافة بين الأسطر حتى لا تتلامس النقاط والحركات عند العرض والطباعة. '.repeat(2);

async function openAndScan(file) {
  const { app, page: win } = await launchLve({ open: file });
  await win.waitForFunction(() => window.__editor && window.SlideDoctor, null, { timeout: 30000 });
  await win.waitForTimeout(300);
  const scan = () => win.evaluate(() => {
    const iss = window.SlideDoctor.analyze(window.__editor);
    return { rules: [...new Set(iss.map((i) => i.ruleId))].sort(), slides: window.__editor.slides().length };
  });
  return { app, win, scan };
}

test('Arabic typography rules fire on the real mistakes and fix all clears them', { timeout: 120000 }, async () => {
  const file = deckFile('mistakes.html', page('', [   // no lang/dir at all: Rule 26
    slide('تباعد وميل', `<p style="letter-spacing:4px">نص عربي بتباعد بين الحروف يكسر اتصالها</p><p style="font-style:italic">نص عربي مائل صناعيًا لا يناسب الخط</p>`),
    slide('أسطر متلاصقة', `<p style="line-height:1.05;font-size:22px">${LONG_AR}</p>`),
    slide('English slide', `<p>This paragraph is English and is laid out right to left by the deck.</p>`)
  ]).replace('<body>', '<body dir="rtl">'));
  const { app, win, scan } = await openAndScan(file);
  try {
    const before = await scan();
    for (const id of ['arabic-letter-spacing', 'arabic-italic', 'arabic-tight-lines', 'text-direction', 'deck-language']) {
      assert.ok(before.rules.includes(id), `rule ${id} did not fire; got ${before.rules.join(',')}`);
    }
    await win.evaluate(async () => {
      for (let pass = 0; pass < 3; pass++) {
        const fixable = window.SlideDoctor.analyze(window.__editor).filter((i) => i.fix && !i.destructive);
        if (!fixable.length) break;
        for (const i of fixable) await i.fix();
        window.__editor.commit();
      }
    });
    const after = await scan();
    for (const id of ['arabic-letter-spacing', 'arabic-italic', 'arabic-tight-lines', 'text-direction', 'deck-language']) {
      assert.ok(!after.rules.includes(id), `rule ${id} survived its own fix`);
    }
    const html = await win.evaluate(() => window.__editor.getCleanHtml());
    assert.match(html, /<html[^>]*lang="ar"/, 'the fix did not reach the saved file');
  } finally { await app.close(); }
});

test('the Arabic rules stay quiet on clean decks, and precise on a real lecture', { timeout: 120000 }, async () => {
  // Chp1-Lec1-2 really does set <em>القرار الهندسي:</em> — slanted Arabic —
  // so exactly that one finding is the right answer there.
  const expect = { 'web/templates/lesson-intro.html': [], 'Chp1-Lec1-2.html': ['arabic-italic'] };
  for (const [rel, want] of Object.entries(expect)) {
    const { app, scan } = await openAndScan(path.join(ROOT, rel));
    try {
      const { rules } = await scan();
      const got = rules.filter((r) => /^(arabic-|text-direction|deck-language)/.test(r));
      assert.deepEqual(got, want, `${rel}: expected ${want.join(',') || 'nothing'}, got ${got.join(',') || 'nothing'}`);
    } finally { await app.close(); }
  }
});

test('fix all never deletes slides; deletions wait for a deliberate click', { timeout: 120000 }, async () => {
  const same = slide('شريحة مكررة', '<p>' + 'نفس المحتوى تمامًا في هذه الشريحة وفي التي بعدها لأغراض الاختبار. '.repeat(3) + '</p>');
  const file = deckFile('dupes.html', page('lang="ar" dir="rtl"', [slide('غلاف', '<p>عرض للاختبار</p>'), same, same, same]));
  const { app, win, scan } = await openAndScan(file);
  try {
    assert.ok((await scan()).rules.includes('duplicate-slide'));
    await win.click('#btn-doctor');
    await win.waitForSelector('.dr-fixall', { timeout: 10000 });
    await win.click('.dr-fixall');
    await win.waitForFunction(() => /صلحت|لا توجد/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    const after = await scan();
    assert.equal(after.slides, 4, 'fix all deleted slides');
    assert.ok(after.rules.includes('duplicate-slide'), 'the duplicate card should still be there for the user to decide');
  } finally { await app.close(); }
});

test('AI-made decks (one slide at a time, reveal.js) open as real slides', { timeout: 120000 }, async () => {
  const chat = deckFile('chat.html', '```html\n<!DOCTYPE html><html lang="ar" dir="rtl"><head><style>section{display:none;height:100vh;padding:8vh 10vw}section.active{display:block}</style></head><body>' +
    ['الأولى', 'الثانية', 'الثالثة', 'الرابعة'].map((t, i) => `<section class="${i ? '' : 'active'}"><h2>الشريحة ${t}</h2><p>محتوى</p></section>`).join('') +
    '<button onclick="go(1)">التالي</button><script>function go(){}</script></body></html>\n```');
  const reveal = deckFile('reveal.html', '<!doctype html><html lang="en"><head></head><body><div class="reveal"><div class="slides">' +
    '<section><h2>One</h2></section><section><section><h2>Two A</h2></section><section><h2>Two B</h2></section></section><section><h2>Three</h2></section>' +
    '</div></div></body></html>');
  for (const [file, want] of [[chat, 4], [reveal, 4]]) {
    const { app, win } = await openAndScan(file);
    try {
      const r = await win.evaluate(() => ({
        slides: window.__editor.slides().length,
        buttons: window.__editor.doc.querySelectorAll('button').length,
        status: document.getElementById('status').textContent
      }));
      assert.equal(r.slides, want, `${path.basename(file)}: ${r.slides} slides`);
      assert.equal(r.buttons, 0, 'the slideshow buttons came along as content');
      assert.match(r.status, /حُوّل العرض/, 'the user was not told the deck was converted');
    } finally { await app.close(); }
  }
});
