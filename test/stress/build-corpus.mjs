// Builds the stress corpus the repo does not ship: an English-only deck, a
// bilingual deck that mixes the hard cases, a "ChatGPT-style" deck that does
// not use the editor's .slide convention, a 130-slide giant, and their PDFs
// (rendered by the running server's own PDF export, so they are real-world
// Chromium PDFs). Output: .preview/corpus (gitignored).
//
// Usage: node test/stress/build-corpus.mjs [baseUrl=http://127.0.0.1:8080]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, '.preview', 'corpus');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
fs.mkdirSync(OUT, { recursive: true });

const CSS = (dir) => `
  *{box-sizing:border-box;}
  body{margin:0;background:#f4f4f6;font-family:'Segoe UI',Tahoma,sans-serif;direction:${dir};}
  .slide{width:950px;height:650px;margin:40px auto;background:#fff;padding:45px 60px;position:relative;
    border-${dir === 'rtl' ? 'right' : 'left'}:12px solid #413258;overflow:hidden;}
  .slide h1{color:#413258;font-size:32px;margin:0 0 14px;border-bottom:3px solid #1AD9C7;padding-bottom:8px;}
  .content{font-size:19px;line-height:1.8;color:#1a1a1a;}
  table{border-collapse:collapse;width:100%;font-size:16px;} td,th{border:1px solid #ccc;padding:6px 10px;}
  code{font-family:Consolas,monospace;background:#f2f2f6;padding:1px 5px;border-radius:4px;}
  .footer{position:absolute;bottom:20px;${dir === 'rtl' ? 'right' : 'left'}:60px;font-size:11px;color:#666;}`;

const deck = (lang, dir, title, slides) => `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${title}</title><style>${CSS(dir)}</style></head><body>
${slides.map((s, i) => `<div class="slide"><h1>${s.h}</h1><div class="content">${s.b}</div><div class="footer">${i + 1} / ${slides.length}</div></div>`).join('\n')}
</body></html>`;

// --- English-only lecture ---------------------------------------------------
const english = deck('en', 'ltr', 'Line Balancing — Week 31', [
  { h: 'Line Balancing and Workstation Design', b: '<p>Week 31 · Industrial Engineering 304</p><p>From the theoretical minimum to an assignment you can run on the shop floor.</p>' },
  { h: 'Learning Objectives', b: '<ul><li>Compute cycle time from demand and available time.</li><li>Find the theoretical minimum number of stations.</li><li>Assign tasks with the Largest Candidate Rule.</li><li>Measure line efficiency and balance delay.</li></ul>' },
  { h: 'Cycle Time', b: '<p>Cycle time <code>C = available time / demand</code>.</p><p>Example: 480 minutes per shift, 96 units required → C = 5 minutes per unit.</p>' },
  { h: 'Task Precedence', b: '<table><tr><th>Task</th><th>Time (min)</th><th>Predecessors</th></tr><tr><td>A</td><td>2.0</td><td>—</td></tr><tr><td>B</td><td>3.5</td><td>A</td></tr><tr><td>C</td><td>1.5</td><td>A</td></tr><tr><td>D</td><td>4.0</td><td>B, C</td></tr><tr><td>E</td><td>2.5</td><td>D</td></tr></table>' },
  { h: 'Theoretical Minimum', b: '<p>N<sub>min</sub> = ⌈ Σt / C ⌉ = ⌈ 13.5 / 5 ⌉ = 3 stations.</p><p>The real answer is often higher: precedence and indivisible tasks waste time.</p>' },
  { h: 'Efficiency and Idle Time', b: '<p>Efficiency = Σt / (N × C) = 13.5 / 15 = <strong>90%</strong>.</p><p>Idle time per cycle = N × C − Σt = 1.5 minutes.</p>' },
  { h: 'Summary', b: '<ol><li>Demand sets the pace.</li><li>Precedence limits the assignment.</li><li>Efficiency tells you how much of the line is waiting.</li></ol>' }
]);

// --- Bilingual: the cases that break naive bidi handling --------------------
const bilingual = deck('ar', 'rtl', 'حالات ثنائية اللغة', [
  { h: 'مقدمة إلى Lean Manufacturing', b: '<p>نستخدم أدوات مثل <strong>5S</strong> و<strong>Kaizen</strong> و<strong>Value Stream Mapping (VSM)</strong> لتقليل الهدر بنسبة 30% تقريبًا.</p><p>المرجع: Womack &amp; Jones, <em>Lean Thinking</em> (1996), p. 15–19.</p>' },
  { h: 'صيغ ومعادلات', b: '<p>زمن الدورة: <code>C = T / D</code> حيث T = 480 min و D = 96 unit.</p><p>الكفاءة = Σt ÷ (N × C) = 13.5 ÷ 15 = 90%.</p><p>دالة Excel: <code>=SUMIF(A2:A20; "&gt;5"; B2:B20)</code></p>' },
  { h: 'أرقام وتواريخ ووحدات', b: '<ul><li>الطول: 12.5 cm والوزن: 3 kg</li><li>التاريخ: 2026-10-22 أو ٢٢/١٠/٢٠٢٦</li><li>الهاتف: +966 50 123 4567</li><li>النطاق (10–20) و[A-Z] و{x, y}</li></ul>' },
  { h: 'English slide inside an Arabic deck', b: '<p>This whole slide is English. It should read left to right even though the deck is RTL.</p><ul><li>First point</li><li>Second point: see section 3.2</li></ul>' },
  { h: 'روابط وبريد', b: '<p>الموقع: https://example.com/lean?lang=ar والبريد: info@example.com</p><p>المسار: C:\\Users\\Lectures\\week-31.pdf</p>' },
  { h: 'جدول مختلط', b: '<table><tr><th>المصطلح</th><th>Term</th><th>القيمة</th></tr><tr><td>زمن الدورة</td><td>Cycle time</td><td>5 min</td></tr><tr><td>الكفاءة</td><td>Efficiency</td><td>90%</td></tr><tr><td>زمن الخمول</td><td>Idle time</td><td>1.5 min</td></tr></table>' },
  { h: 'تنسيقات تفسد العربية', b: '<p style="letter-spacing:3px">نص بمسافات بين الحروف تكسر اتصال الحروف العربية</p><p style="font-style:italic">نص مائل صناعيًا لا يناسب الخط العربي</p><p style="line-height:1.0;font-size:22px">سطر مُتلاصِق جدًّا تُقصّ فيه الحَرَكاتُ والتَّشكيلُ عند الطباعةِ والعرضِ</p>' }
]);

// --- ChatGPT-style deck: no .slide class, one-at-a-time JS, fenced ----------
const chatgpt = '```html\n<!DOCTYPE html>\n<html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>عرض من ChatGPT</title><style>\n' +
  'body{margin:0;font-family:Tahoma,sans-serif;background:#111;color:#fff}\n' +
  'section{display:none;width:100vw;height:100vh;padding:8vh 10vw;box-sizing:border-box}\nsection.active{display:block}\n' +
  'h2{font-size:48px;color:#ffd166}p,li{font-size:26px;line-height:1.7}\n.nav{position:fixed;bottom:20px;left:20px}\n</style></head><body>\n' +
  ['أهلًا بكم في محاضرة التحليل الإحصائي', 'ما هو المتوسط الحسابي؟', 'الوسيط والمنوال', 'الانحراف المعياري', 'تمرين تطبيقي', 'الخلاصة']
    .map((t, i) => `<section class="${i === 0 ? 'active' : ''}"><h2>${t}</h2><p>نقطة توضيحية رقم ${i + 1} حول ${t}.</p><ul><li>مثال أول</li><li>مثال ثانٍ</li></ul></section>`).join('\n') +
  '\n<div class="nav"><button onclick="go(-1)">السابق</button><button onclick="go(1)">التالي</button></div>\n' +
  '<script>let i=0;const s=document.querySelectorAll("section");function go(d){s[i].classList.remove("active");i=Math.max(0,Math.min(s.length-1,i+d));s[i].classList.add("active")}</script>\n</body></html>\n```\nيمكنك حفظ هذا الملف وفتحه في المتصفح.';

// --- Giant: the real 26-slide lecture, five times over ----------------------
const lecture = fs.readFileSync(path.join(ROOT, 'Chp1-Lec1-2.html'), 'utf8');
const bodyStart = lecture.indexOf('<body'), bodyOpenEnd = lecture.indexOf('>', bodyStart) + 1, bodyEnd = lecture.lastIndexOf('</body>');
const body = lecture.slice(bodyOpenEnd, bodyEnd);
const giant = lecture.slice(0, bodyOpenEnd) + body.repeat(5) + lecture.slice(bodyEnd);

// --- reveal.js-shaped deck, with one vertical stack ------------------------
const reveal = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reveal deck</title>
<style>.reveal{font-family:Georgia,serif}.reveal section{padding:40px}.reveal h2{font-size:44px;color:#333}</style></head>
<body><div class="reveal"><div class="slides">
<section><h2>Statistics 101</h2><p>An introduction for first-year students.</p></section>
<section><h2>Mean</h2><p>The average of all values.</p></section>
<section><section><h2>Median</h2><p>The middle value.</p></section><section><h2>Median: example</h2><p>1, 3, 7 → 3</p></section></section>
<section><h2>Questions?</h2></section>
</div></div><script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script><script>Reveal.initialize();</script></body></html>`;

const files = { 'reveal-deck.html': reveal, 'english-deck.html': english, 'bilingual-deck.html': bilingual, 'chatgpt-deck.html': chatgpt, 'giant-deck.html': giant };
for (const [name, html] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), html, 'utf8');

// PDFs through the server's own export (headless Chromium at deck geometry).
async function toPdf(htmlName, pdfName) {
  const html = fs.readFileSync(path.join(OUT, htmlName), 'utf8');
  const res = await fetch(BASE + '/api/export/pdf', {
    method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' },
    body: JSON.stringify({ html, name: pdfName.replace(/\.pdf$/, '') })
  });
  if (!res.ok) throw new Error(`${pdfName}: ${res.status} ${await res.text()}`);
  fs.writeFileSync(path.join(OUT, pdfName), Buffer.from(await res.arrayBuffer()));
}
await toPdf('english-deck.html', 'english.pdf');
await toPdf('bilingual-deck.html', 'bilingual.pdf');
await toPdf('giant-deck.html', 'giant.pdf');
await toPdf(path.relative(OUT, path.join(ROOT, 'test', 'fixtures', 'gate-deck.html')), 'one-page.pdf');

for (const f of fs.readdirSync(OUT)) console.log(String(Math.round(fs.statSync(path.join(OUT, f)).size / 1024)).padStart(6) + ' KB  ' + f);
