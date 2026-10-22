import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { PNG } from "pngjs";
import { release } from "../extract/mupdf-lifetime.js";

/**
 * Render a source PDF page into the exact slide canvas used by the model.
 * Mixed-size pages keep their fitted side bands instead of being stretched.
 */
export function sourcePagePng(pdfPath, page, outFile, { widthPx = 1400 } = {}) {
  let doc = null, pdfPage = null, pix = null;
  try {
    doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf");
    pdfPage = doc.loadPage(page.index);
    const canvasW = widthPx;
    const canvasH = Math.max(1, Math.round(widthPx * page.heightPt / page.widthPt));
    const fit = page.sourceFit ?? { scale: 1, x: 0, y: 0 };
    const scalePx = (widthPx / page.widthPt) * fit.scale;
    pix = pdfPage.toPixmap(mupdf.Matrix.scale(scalePx, scalePx), mupdf.ColorSpace.DeviceRGB, false, true);

    const png = new PNG({ width: canvasW, height: canvasH, colorType: 6 });
    png.data.fill(255);
    const x0 = Math.round((fit.x ?? 0) * widthPx / page.widthPt);
    const y0 = Math.round((fit.y ?? 0) * widthPx / page.widthPt);
    const src = pix.getPixels();
    const channels = pix.getNumberOfComponents();
    const stride = pix.getStride();
    for (let y = 0; y < pix.getHeight(); y++) {
      const dy = y0 + y;
      if (dy < 0 || dy >= canvasH) continue;
      for (let x = 0; x < pix.getWidth(); x++) {
        const dx = x0 + x;
        if (dx < 0 || dx >= canvasW) continue;
        const si = y * stride + x * channels;
        const di = (dy * canvasW + dx) * 4;
        if (channels === 1 || channels === 2) {
          png.data[di] = src[si]; png.data[di + 1] = src[si]; png.data[di + 2] = src[si];
        } else {
          png.data[di] = src[si]; png.data[di + 1] = src[si + 1]; png.data[di + 2] = src[si + 2];
        }
        png.data[di + 3] = channels === 2 || channels === 4 ? src[si + channels - 1] : 255;
      }
    }
    fs.writeFileSync(outFile, PNG.sync.write(png));
    return { file: outFile, width: canvasW, height: canvasH };
  } finally {
    release(pix, pdfPage, doc);
  }
}

