/**
 * build-matrix.mjs — generates the portability test matrix from the CV PDF.
 * Variants:
 *  v01 baseline converter output (already built)
 *  v02 editable, no font embedding (strip embedded fonts)
 *  v03 Segoe UI substitution (no embed)
 *  v04 Arial substitution (no embed)
 *  v05 Calibri substitution (no embed)
 *  v06 PowerPoint COM re-save with EmbedTrueTypeFonts (Segoe version)
 *  v07 full-slide raster flatten (200 dpi PNG per page)
 *  v08 raster background + editable overlay text (Segoe UI)
 *  v09 editable text with embedded fonts via PowerPoint COM (baseline deck re-saved by PowerPoint)
 *  v10 hybrid: raster background + editable Segoe UI text (same as v08 but text hidden behind? -> kept as "background + overlay visible text" control)
 */
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import * as m from 'mupdf';
import PptxGenJS from 'pptxgenjs';

const SRC = 'd:/pdf=ppt/out/matrix/v01-baseline-converter.pptx';
const OUT = 'd:/pdf=ppt/out/matrix';
const PDF = 'C:/Users/mosun/Downloads/Mohamed_Sameh_Shams_AI_Engineer_CV.pdf';

function stripEmbed(zip) {
  const out = new AdmZip();
  for (const e of zip.getEntries()) {
    const n = e.entryName;
    if (/^\/?ppt\/fonts\//.test(n) || /fontParts|embeddedFont/i.test(n)) continue;
    let data = e.getData();
    if (n === '[Content_Types].xml') {
      data = Buffer.from(data.toString('utf8')
        .replace(/<Override PartName="\/ppt\/fonts\/[^"]*"[^/]*\/>/g, '')
        .replace(/fntdata/g, 'x-fntdata'), 'utf8');
    }
    if (n === 'ppt/presentation.xml') {
      data = Buffer.from(data.toString('utf8').replace(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/g, ''), 'utf8');
    }
    if (/\.rels$/.test(n)) {
      data = Buffer.from(data.toString('utf8')
        .replace(/<Relationship [^>]*Target="fonts\/[^"]*"[^>]*\/>/g, ''), 'utf8');
    }
    out.addFile(n, data);
  }
  return out;
}

function renameFont(zip, from, to) {
  const out = new AdmZip();
  for (const e of zip.getEntries()) {
    let data = e.getData();
    if (/\.xml$/.test(e.entryName)) {
      data = Buffer.from(data.toString('utf8').split(from).join(to), 'utf8');
    }
    out.addFile(e.entryName, data);
  }
  return out;
}

const base = new AdmZip(SRC);

// v02: no embedding
stripEmbed(base).writeZip(path.join(OUT, 'v02-no-embed.pptx'));
console.log('v02 done');

// v03/v04/v05: substitutions, no embed
for (const [file, font] of [['v03-segoe-ui.pptx', 'Segoe UI'], ['v04-arial.pptx', 'Arial'], ['v05-calibri.pptx', 'Calibri']]) {
  const stripped = stripEmbed(base);
  const z = renameFont(stripped, 'Helvetica', font);
  z.writeZip(path.join(OUT, file));
  console.log(file, 'done');
}

// render pages to PNG for v07/v08
const buf = fs.readFileSync(PDF);
const doc = m.PDFDocument.openDocument(buf, 'application/pdf');
const pngs = [];
for (let i = 0; i < doc.countPages(); i++) {
  const page = doc.loadPage(i);
  const pix = page.toPixmap(m.Matrix.scale(200 / 72, 200 / 72), m.ColorSpace.DeviceRGB, false);
  const pngPath = path.join(OUT, `page${i}.png`);
  fs.writeFileSync(pngPath, pix.asPNG());
  pngs.push(pngPath);
  pix.destroy();
}
console.log('renders done', pngs);

// v07: full-slide raster flatten
{
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LETTER', width: 8.5, height: 11 });
  pptx.layout = 'LETTER';
  for (const p of pngs) {
    const s = pptx.addSlide();
    s.addImage({ path: p, x: 0, y: 0, w: 8.5, h: 11 });
  }
  await pptx.writeFile({ fileName: path.join(OUT, 'v07-raster-flatten.pptx') });
  console.log('v07 done');
}

// v08: raster background + editable overlay text
{
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LETTER', width: 8.5, height: 11 });
  pptx.layout = 'LETTER';
  for (let i = 0; i < doc.countPages(); i++) {
    const s = pptx.addSlide();
    s.addImage({ path: pngs[i], x: 0, y: 0, w: 8.5, h: 11 });
    const st = doc.loadPage(i).toStructuredText('preserve-whitespace');
    const j = JSON.parse(st.asJSON());
    for (const block of j.blocks || []) {
      for (const line of block.lines || []) {
        if (!line.text.trim()) continue;
        const { x, y, w, h } = line.bbox;
        s.addText(line.text, {
          x: x / 72, y: y / 72, w: Math.max(w / 72, 0.3), h: Math.max(h / 72 + 0.06, 0.15),
          fontSize: Math.max(6, line.font.size),
          bold: String(line.font.weight).toLowerCase() === 'bold',
          fontFace: 'Segoe UI', color: 'FFFFFF', margin: 0,
        });
      }
    }
  }
  await pptx.writeFile({ fileName: path.join(OUT, 'v08-bg-overlay.pptx') });
  // post-process: make overlay text nearly transparent (alpha 4%) so only background shows
  const z = new AdmZip(path.join(OUT, 'v08-bg-overlay.pptx'));
  for (const e of z.getEntries()) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)) {
      const xml = e.getData().toString('utf8')
        .replace(/<a:srgbClr val="FFFFFF"\/>/g, '<a:srgbClr val="010203"><a:alpha val="4000"/></a:srgbClr>');
      z.updateFile(e.entryName, Buffer.from(xml, 'utf8'));
    }
  }
  z.writeZip(path.join(OUT, 'v08-bg-overlay.pptx'));
  console.log('v08 done');
}
// v06-prep: add embedTrueTypeFonts attr so PowerPoint embeds Segoe UI on re-save
{
  const z = new AdmZip(path.join(OUT, 'v03-segoe-ui.pptx'));
  for (const e of z.getEntries()) {
    if (e.entryName === 'ppt/presentation.xml') {
      const xml = e.getData().toString('utf8')
        .replace('<p:presentation ', '<p:presentation embedTrueTypeFonts="1" ');
      z.updateFile(e.entryName, Buffer.from(xml, 'utf8'));
    }
  }
  z.writeZip(path.join(OUT, 'v06-powerpoint-embedded-segoe.pptx'));
  console.log('v06 prep done');
}
// v10: faded background + visible editable Segoe UI overlay
import { PNG } from 'pngjs';
{
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LETTER', width: 8.5, height: 11 });
  pptx.layout = 'LETTER';
  for (let i = 0; i < doc.countPages(); i++) {
    const png = PNG.sync.read(fs.readFileSync(pngs[i]));
    for (let p = 0; p < png.data.length; p += 4) {
      // blend toward white at 78% white => content faded to ~22%
      png.data[p] = Math.round(png.data[p] * 0.22 + 255 * 0.78);
      png.data[p + 1] = Math.round(png.data[p + 1] * 0.22 + 255 * 0.78);
      png.data[p + 2] = Math.round(png.data[p + 2] * 0.22 + 255 * 0.78);
    }
    const faded = path.join(OUT, `page${i}-faded.png`);
    fs.writeFileSync(faded, PNG.sync.write(png));
    const s = pptx.addSlide();
    s.addImage({ path: faded, x: 0, y: 0, w: 8.5, h: 11 });
    const st = doc.loadPage(i).toStructuredText('preserve-whitespace');
    const j = JSON.parse(st.asJSON());
    for (const block of j.blocks || []) {
      for (const line of block.lines || []) {
        if (!line.text.trim()) continue;
        const { x, y, w, h } = line.bbox;
        s.addText(line.text, {
          x: x / 72, y: y / 72, w: Math.max(w / 72, 0.3), h: Math.max(h / 72 + 0.06, 0.15),
          fontSize: Math.max(6, line.font.size),
          bold: String(line.font.weight).toLowerCase() === 'bold',
          fontFace: 'Segoe UI', color: '1A1A1A', margin: 0,
        });
      }
    }
  }
  await pptx.writeFile({ fileName: path.join(OUT, 'v10-faded-bg-editable.pptx') });
  console.log('v10 done');
}
console.log('ALL DONE');
