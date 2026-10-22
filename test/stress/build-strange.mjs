// Strange inputs: the files real users actually have that no happy-path test
// covers. Output: .preview/strange (gitignored). PDFs that need real text are
// printed by the running server's own Chromium; the structural oddities
// (encryption, rotation, mixed sizes, truncation) are made with MuPDF.
//
// Usage: node test/stress/build-strange.mjs [baseUrl=http://127.0.0.1:8080]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, '.preview', 'strange');
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const mupdf = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const put = (name, data) => fs.writeFileSync(path.join(OUT, name), data);
const LECTURE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'lecture.pdf'));

async function print(html, name) {
  const r = await fetch(BASE + '/api/export/pdf', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ html, name: 'x' }) });
  if (!r.ok) throw new Error(name + ': ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (name) put(name, buf);
  return buf;
}
const slideDoc = (body, { w = 950, h = 650, dir = 'rtl', lang = 'ar', css = '' } = {}) =>
  `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><style>body{margin:0;font-family:'Segoe UI',Tahoma,sans-serif}
  .slide{width:${w}px;height:${h}px;padding:40px 56px;box-sizing:border-box;overflow:hidden;position:relative;background:#fff}
  h1{font-size:34px;margin:0 0 18px;color:#2a2440} p,li{font-size:22px;line-height:1.8}${css}</style></head><body>${body}</body></html>`;

// ------------------------------------------------------------- PDFs --------
put('empty.pdf', Buffer.alloc(0));
put('picture-renamed.pdf', fs.readFileSync(path.join(ROOT, 'web', 'fonts', 'f0.woff2')).subarray(0, 4000)); // not a PDF at all
put('truncated.pdf', LECTURE.subarray(0, Math.floor(LECTURE.length * 0.55)));          // half a download

const scripts = await print(slideDoc(
  '<div class="slide"><h1>نصوص من لغات مختلفة 🌍</h1><p>إيموجي: 📊 ✅ 🎓 ❤️ 👍🏽</p><p lang="he" dir="rtl">עברית: שלום עולם</p>' +
  '<p lang="zh" dir="ltr">中文：你好，世界</p><p dir="ltr">Math: ∑ x² ≤ √π · ∞ ≠ ∂f/∂x — α β γ</p></div>' +
  '<div class="slide"><h1>نص مشكول بالكامل</h1><p>بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ</p>' +
  '<p>كلمــــة ممدودة بالتطويل، وأرقام هندية ١٢٣٫٤٥ وغربية 123.45، ونسبة ٪٢٥ و25%.</p><p>اقتباس «بين قوسين» و(أقواس) و[معقوفين] و{مجعدين}.</p></div>'), 'scripts-emoji-harakat.pdf');

const portrait = await print(slideDoc('<div class="slide"><h1>صفحة طولية A4</h1><p>تقرير بصفحة طولية وسط عرض أفقي.</p></div>', { w: 794, h: 1123 }));
const poster = await print(slideDoc('<div class="slide"><h1 style="font-size:120px">ملصق ضخم A0</h1><p style="font-size:60px">صفحة بحجم ملصق كامل.</p></div>', { w: 3179, h: 4494 }), 'poster-a0.pdf');
const card = await print(slideDoc('<div class="slide" style="padding:10px"><h1 style="font-size:14px;margin:0">بطاقة عمل</h1><p style="font-size:9px;line-height:1.4;margin:0">د. محمد — mohamed@example.com</p></div>', { w: 336, h: 192 }), 'business-card.pdf');

// mixed portrait + landscape: graft pages from two documents into one
{
  const out = new mupdf.PDFDocument();
  const a = mupdf.Document.openDocument(LECTURE, 'application/pdf').asPDF();
  const b = mupdf.Document.openDocument(portrait, 'application/pdf').asPDF();
  out.graftPage(-1, a, 0); out.graftPage(-1, b, 0); out.graftPage(-1, a, 1);
  put('mixed-orientation.pdf', Buffer.from(out.saveToBuffer('').asUint8Array()));
}
// a page stored rotated (scanner habit): /Rotate 90 on page 1
{
  const d = mupdf.Document.openDocument(LECTURE, 'application/pdf').asPDF();
  d.findPage(0).put('Rotate', 90);
  put('rotated-page.pdf', Buffer.from(d.saveToBuffer('').asUint8Array()));
}
// password-protected
{
  const d = mupdf.Document.openDocument(LECTURE, 'application/pdf').asPDF();
  put('password.pdf', Buffer.from(d.saveToBuffer('encrypt=aes-256,user-password=secret,owner-password=owner').asUint8Array()));
}
// over the 200-page budget: the 21-page lecture, 12 times
{
  const out = new mupdf.PDFDocument();
  const a = mupdf.Document.openDocument(LECTURE, 'application/pdf').asPDF();
  for (let k = 0; k < 12; k++) for (let i = 0; i < 21; i++) out.graftPage(-1, a, i);
  put('over-limit-252p.pdf', Buffer.from(out.saveToBuffer('').asUint8Array()));
}
// annotations and a form field over a normal page
{
  const d = mupdf.Document.openDocument(LECTURE, 'application/pdf').asPDF();
  const pg = d.loadPage(0);
  const note = pg.createAnnotation('Text'); note.setContents('ملاحظة المراجع: راجع هذه الشريحة'); note.setRect([40, 40, 60, 60]); note.update();
  const hl = pg.createAnnotation('Highlight'); hl.setQuadPoints([[100, 100, 300, 100, 100, 130, 300, 130]]); hl.update();
  put('annotated.pdf', Buffer.from(d.saveToBuffer('').asUint8Array()));
}

// ------------------------------------------------------------- HTML --------
const AR_DECK = slideDoc('<div class="slide"><h1>عنوان الشريحة</h1><p>محاضرة قديمة محفوظة بترميز ويندوز العربي.</p><ul><li>البند الأول</li><li>البند الثاني</li></ul></div>' +
  '<div class="slide"><h1>الشريحة الثانية</h1><p>نص عربي: الأرقام ١٢٣ والعلامات «» ، ؛ ؟</p></div>')
  .replace('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1256">');
// windows-1256: the encoding Arabic Windows/Office/FrontPage saved for decades
{
  const enc = new Map(); // build a reverse map from the decoder itself
  const dec = new TextDecoder('windows-1256');
  for (let b = 0x80; b < 0x100; b++) { const ch = dec.decode(Uint8Array.of(b)); if (ch !== '\uFFFD') enc.set(ch, b); }
  const bytes = [];
  for (const ch of AR_DECK) { const c = ch.codePointAt(0); if (c < 0x80) bytes.push(c); else if (enc.has(ch)) bytes.push(enc.get(ch)); else bytes.push(0x3f); }
  put('windows-1256.html', Buffer.from(bytes));
}
put('utf16-bom.html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(AR_DECK.replace(/<meta[^>]*>/, '<meta charset="utf-16">'), 'utf16le')]));
put('empty.html', '');
put('plain-text.html', 'هذا ملف نصي عادي بلا أي وسوم HTML.\nسطر ثانٍ.\nThird line in English.');
put('article-not-deck.html', `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>مقال</title></head><body><header><nav><a href="#">الرئيسية</a> | <a href="#">عن الموقع</a></nav></header><main><article><h1>مقال طويل عن إدارة الجودة</h1>${Array.from({ length: 30 }, (_, i) => `<h2>القسم ${i + 1}</h2><p>${'إدارة الجودة الشاملة منهج يهدف إلى تحسين العمليات باستمرار. '.repeat(8)}</p>`).join('')}</article></main><footer>© 2026</footer></body></html>`);
put('js-built-deck.html', `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>.slide{width:950px;height:650px;margin:20px auto;padding:40px;box-sizing:border-box;background:#fff;border:1px solid #ddd}</style></head><body><div id="root"></div>
<script>const data=[["مقدمة","شرائح يبنيها جافاسكربت عند التحميل"],["الفكرة","لا توجد شرائح في الملف نفسه"],["الخطر","عند الحفظ وإعادة الفتح قد تتكرر"]];
document.getElementById('root').innerHTML=data.map(function(d){return '<div class="slide"><h1>'+d[0]+'</h1><p>'+d[1]+'</p></div>'}).join('');</script></body></html>`);
put('mixed-slide-sizes.html', slideDoc('<div class="slide"><h1>شريحة 950×650</h1></div><div class="slide" style="width:1280px;height:720px"><h1>شريحة 16:9</h1></div><div class="slide" style="width:794px;height:1123px"><h1>صفحة A4 طولية</h1></div>'));
put('remote-and-missing-images.html', slideDoc('<div class="slide"><h1>صور من الإنترنت ومفقودة</h1><img src="https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg" style="width:300px"><img src="missing-photo.png" style="width:200px"><img src="file:///C:/does/not/exist.png" style="width:200px"></div>'));
{
  // a ~10 MB image: a PNG of noise (incompressible) as a data URL
  const { PNG } = (await import('node:module')).createRequire(path.join(ROOT, 'package.json'))('pngjs');
  const png = new PNG({ width: 1800, height: 1400 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = (i % 4 === 3) ? 255 : (Math.random() * 256) | 0;
  const b64 = PNG.sync.write(png).toString('base64');
  put('huge-image.html', slideDoc(`<div class="slide"><h1>صورة ضخمة مضمّنة</h1><img src="data:image/png;base64,${b64}" style="width:600px"></div>`));
}
put('500-slides.html', slideDoc(Array.from({ length: 500 }, (_, i) => `<div class="slide"><h1>الشريحة رقم ${i + 1}</h1><p>محتوى قصير ${i + 1}.</p></div>`).join('')));
put('media-and-iframes.html', slideDoc('<div class="slide"><h1>وسائط</h1><video src="lecture.mp4" controls width="320"></video><audio src="intro.mp3" controls></audio><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="320" height="180"></iframe><canvas id="c" width="200" height="100"></canvas></div>'));
put('scripts-emoji.html', slideDoc('<div class="slide"><h1>لغات ورموز 🌍</h1><p>إيموجي 📊 ✅ 🎓</p><p lang="he">עברית: שלום</p><p lang="zh" dir="ltr">中文：你好</p><p dir="ltr">Math: ∑ x² ≤ √π</p><p>بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ — كلمــــة ممدودة</p></div>'));
put('fixed-and-animated.html', slideDoc('<div class="slide"><h1 style="animation:spin 2s infinite">عنوان متحرك</h1><div style="position:fixed;bottom:0;left:0;background:#c00;color:#fff;padding:6px">شريط ثابت</div><p style="transform:rotate(-8deg)">نص مائل بالتحويل</p></div>', { css: '@keyframes spin{to{transform:rotate(360deg)}}' }));

for (const f of fs.readdirSync(OUT).sort()) console.log(String(Math.round(fs.statSync(path.join(OUT, f)).size / 1024)).padStart(7) + ' KB  ' + f);
