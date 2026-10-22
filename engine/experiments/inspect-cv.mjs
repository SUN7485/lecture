import * as m from 'mupdf';
import fs from 'fs';

const buf = fs.readFileSync('C:/Users/mosun/Downloads/Mohamed_Sameh_Shams_AI_Engineer_CV.pdf');
const doc = m.PDFDocument.openDocument(buf, 'application/pdf');
const n = doc.countPages();
console.log('pages', n);

const fontSet = new Map();
for (let i = 0; i < n; i++) {
  const page = doc.loadPage(i);
  console.log(`--- page ${i} bounds`, page.getBounds().map(v => Math.round(v)));
  const st = page.toStructuredText();
  st.walk({
    onChar(c, origin, font, size, quad) {
      if (!fontSet.has(font.name)) fontSet.set(font.name, new Set());
      const s = fontSet.get(font.name);
      if (s.size < 3 && c.trim()) s.add(c);
    }
  });
}
for (const [k, v] of fontSet) console.log('FONT:', k, JSON.stringify([...v]));

fs.mkdirSync('d:/pdf=ppt/out', { recursive: true });
for (let i = 0; i < n; i++) {
  const st = doc.loadPage(i).toStructuredText();
  fs.writeFileSync(`d:/pdf=ppt/out/cv-page${i}.txt`, st.asText());
}
