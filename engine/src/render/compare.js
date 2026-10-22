/**
 * Ink-restricted visual comparison: source PDF page vs PowerPoint's render.
 *
 * Whole-page SSIM on a lecture slide is close to meaningless — the page is
 * mostly white, so any two slides score ~0.95 and a real defect disappears into
 * the average. We instead build an INK MASK for each side (pixels that differ
 * from the background) and compare only where either side has content:
 *
 *   inkIoU        intersection / union of the two ink masks
 *   missingInk    source has ink, ours does not   (something was dropped)
 *   extraInk      ours has ink, source does not   (something was invented)
 *   inkShiftY     vertical offset that maximises overlap — this is what
 *                 calibrates the writer's baseline nudge
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";
import * as mupdf from "mupdf";

/** A pixel counts as ink when it is this far from white (0-255 per channel). */
const INK_THRESHOLD = 28;

export function renderPdfPage(pdfPath, pageIndex, widthPx) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf");
  const page = doc.loadPage(pageIndex);
  const [x0, y0, x1, y1] = page.getBounds();
  const scale = widthPx / (x1 - x0);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  return { width: pix.getWidth(), height: pix.getHeight(), data: pix.getPixels(), channels: pix.getNumberOfComponents() };
}

export function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data, channels: 4 };
}

/**
 * How far either side of the threshold a pixel is too close to call.
 *
 * The threshold is a hard step, and two renderers do not agree to the last
 * greyscale value on a flat fill. Measured on the InDesign brand guide p34: the
 * same grey is 226 in MuPDF and 227 in PowerPoint — one apart, straddling the
 * cut — which moved 38759 pixels, 64% of that page's whole ink mask, and scored
 * a correct page 0.360 with "62.1% missing". A band of 2 covers that
 * disagreement with room to spare while leaving real ink (text is far darker)
 * untouched. This is EVO-023's tolerance argument in VALUE space; the 2px
 * dilation already bought the same tolerance in SPACE.
 */
const INK_DEAD_BAND = 2;

/**
 * Ink mask, plus the pixels too near the threshold for either answer to mean
 * anything. `band = 0` reproduces the old hard cut exactly.
 */
export function inkMasks({ width, height, data, channels }, band = INK_DEAD_BAND) {
  const ink = new Uint8Array(width * height);
  const uncertain = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ink.length; i++, p += channels) {
    const a = channels === 4 ? data[p + 3] : 255;
    if (a < 16) continue;                                   // transparent = background
    const d = Math.max(255 - data[p], 255 - data[p + 1], 255 - data[p + 2]);
    if (d > INK_THRESHOLD + band) ink[i] = 1;
    else if (d > INK_THRESHOLD - band) uncertain[i] = 1;
  }
  return { ink, uncertain };
}

/** Boolean ink mask, one entry per pixel. The original hard cut, unchanged. */
export function inkMask(img) {
  return inkMasks(img, 0).ink;
}

/** Nearest-neighbour resample of a mask to a target size. */
function resampleMask(mask, w, h, tw, th) {
  if (w === tw && h === th) return mask;
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / tw));
      out[y * tw + x] = mask[sy * w + sx];
    }
  }
  return out;
}

/**
 * Grow a mask by `r` pixels in each direction (separable box dilation).
 *
 * Without this the comparison measures font rasterisation, not fidelity: a
 * glyph stroke is ~2px wide at 1400px, so MuPDF and PowerPoint hinting the same
 * letter one subpixel apart scores as both "missing" and "extra" and the IoU
 * collapses. Dilating asks the question we actually care about — is there ink
 * within a pixel or two of where the source has ink.
 */
function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && mask[y * w + xx]) v = 1;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Compare two ink masks at a vertical offset, with tolerance.
 * `aD`/`bD` are the dilated forms: source ink counts as covered if OUR dilated
 * mask reaches it, and vice versa.
 */
function scoreAt(a, b, aD, bD, w, h, dy) {
  let inter = 0, missing = 0, extra = 0, aInk = 0, bInk = 0;
  for (let y = 0; y < h; y++) {
    const by = y + dy;
    if (by < 0 || by >= h) continue;
    const ra = y * w, rb = by * w;
    for (let x = 0; x < w; x++) {
      const av = a[ra + x], bv = b[rb + x];
      if (av) { aInk++; if (bD[rb + x]) inter++; else missing++; }
      if (bv) { bInk++; if (!aD[ra + x]) extra++; }
    }
  }
  const union = aInk + bInk - inter;
  // With tolerance dilation, one source pixel can be considered covered by a
  // nearby output pixel even when the approximate `union` is slightly smaller
  // than `inter`. IoU is a bounded score by definition; four fitted corpus
  // pages otherwise reported impossible values between 1.0006 and 1.0026.
  return { iou: union ? Math.min(1, inter / union) : 1, inter, union, missing, extra };
}


/**
 * Render a source page the way fitPagesToCanvas placed it on the slide.
 *
 * A document whose pages are not all one size (a merged lecture: 87 landscape
 * pages and 31 square ones) is fitted uniformly into the dominant canvas with
 * empty side bands. Comparing such a page against a full-width render measures
 * the BAND, not the reconstruction, and reports a correct slide as a total
 * failure. The band width is recoverable from the offset alone — the fit is
 * centred, so content width is canvas minus twice the offset — which is why
 * this needs no page bounds of its own.
 */
function renderPdfPageFitted(pdfPath, pageIndex, shot, fit) {
  const k = shot.width / fit.canvasWPt;
  const x0 = Math.round(fit.xPt * k), y0 = Math.round(fit.yPt * k);
  const contentW = Math.max(1, shot.width - 2 * x0);
  const page = renderPdfPage(pdfPath, pageIndex, contentW);

  // White canvas the size of our slide render, page pasted into its band.
  const data = new Uint8Array(shot.width * shot.height * 3).fill(255);
  for (let y = 0; y < page.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= shot.height) continue;
    for (let x = 0; x < page.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= shot.width) continue;
      const si = (y * page.width + x) * page.channels, di = (dy * shot.width + dx) * 3;
      data[di] = page.data[si]; data[di + 1] = page.data[si + 1]; data[di + 2] = page.data[si + 2];
    }
  }
  return { width: shot.width, height: shot.height, data, channels: 3 };
}

/**
 * Compare one source page against one rendered slide.
 * `searchY` sweeps a vertical offset so we can report both the raw alignment
 * and the best achievable one — the gap between them is the systematic baseline
 * error the writer should be corrected by.
 */
export function comparePage(pdfPath, pageIndex, slidePng,
  { widthPx = 1400, searchY = 12, tolerance = 2, fit = null, deadBand = INK_DEAD_BAND } = {}) {
  const shot = readPng(slidePng);
  const src = fit ? renderPdfPageFitted(pdfPath, pageIndex, shot, fit) : renderPdfPage(pdfPath, pageIndex, shot.width);

  const w = shot.width, h = Math.min(shot.height, src.height);
  // `deadBand: 0` is the old hard cut, kept reachable so the band's effect can
  // be measured through this exact function instead of a probe that re-derives it.
  const srcSide = inkMasks(src, deadBand), ourSide = inkMasks(shot, deadBand);
  const srcMask = resampleMask(srcSide.ink, src.width, src.height, w, h);
  const ourMask = resampleMask(ourSide.ink, shot.width, shot.height, w, h);

  // A pixel either side cannot call is evidence for nobody. Dropping it from
  // BOTH masks is what stops a flat fill that lands on the threshold from being
  // scored as ink present in one render and absent in the other — and it has to
  // be symmetric, or the exclusion would itself become a difference.
  const srcU = resampleMask(srcSide.uncertain, src.width, src.height, w, h);
  const ourU = resampleMask(ourSide.uncertain, shot.width, shot.height, w, h);
  let undecided = 0;
  for (let i = 0; i < srcMask.length; i++) {
    if (!srcU[i] && !ourU[i]) continue;
    undecided++;
    srcMask[i] = 0; ourMask[i] = 0;
  }

  const srcD = dilate(srcMask, w, h, tolerance);
  const ourD = dilate(ourMask, w, h, tolerance);

  const raw = scoreAt(srcMask, ourMask, srcD, ourD, w, h, 0);
  let best = { ...raw, dy: 0 };
  for (let dy = -searchY; dy <= searchY; dy++) {
    const s = scoreAt(srcMask, ourMask, srcD, ourD, w, h, dy);
    if (s.iou > best.iou) best = { ...s, dy };
  }

  const srcInk = srcMask.reduce((n, v) => n + v, 0);
  const ourInk = ourMask.reduce((n, v) => n + v, 0);

  return {
    width: w, height: h,
    sourceInkPx: srcInk,
    ourInkPx: ourInk,
    // Pixels neither render could call, excluded from both masks. A large value
    // means the page is mostly flat fills near the threshold, so read the score
    // as describing only what is left.
    undecidedPx: undecided,
    inkRatio: srcInk ? ourInk / srcInk : 0,
    raw: { iou: raw.iou, missingPct: srcInk ? raw.missing / srcInk : 0, extraPct: srcInk ? raw.extra / srcInk : 0 },
    best: { iou: best.iou, dy: best.dy, missingPct: srcInk ? best.missing / srcInk : 0, extraPct: srcInk ? best.extra / srcInk : 0 },
  };
}
