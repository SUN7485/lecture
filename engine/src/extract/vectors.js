/**
 * Vector extraction from a native PDF page.
 *
 * We run the page through a JS `Device` rather than reading the structured
 * text walker's `onVector` summary: that only reports a bounding box and a
 * colour, which is enough to know something was drawn but not enough to rebuild
 * it as an editable PowerPoint shape. The Device gives us the real path, its
 * transform, fill/stroke state and alpha.
 *
 * Everything is captured in PAINT ORDER, which becomes z-order in the output.
 */
import * as mupdf from "mupdf";
import { detachBorrowed, release } from "./mupdf-lifetime.js";

/** Points below this are treated as coincident when classifying a shape. */
const EPS = 0.35;

/** Apply a MuPDF matrix [a,b,c,d,e,f] to a point. */
const tx = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * When to spend a second encode asking whether PNG would have been better.
 *
 * Measured over every image in the corpus (`experiments/probe-image-encoding.js`),
 * and the split is not a preference — it is what the two formats are for:
 *
 *   3-component photographs   PNG loses every time, by 1.9x to 7.7x
 *                             (all-PNG 24.7MB vs all-JPEG 5.5MB, 29 images)
 *   1-component flat art      PNG wins — the 2561x2335 grayscale page on
 *                             test.pdf p12 is 46KB as PNG and 71KB as JPEG
 *
 * So the comparison is paid where it can be won and where it is cheap: greyscale
 * (a third of the data, and overwhelmingly scanned or flat art in a PDF) and
 * anything small enough that the encode does not matter.
 */
const PNG_COMPARISON_PIXELS = 256 * 256;
const PNG_COMPARISON_COMPONENTS = 2;

/**
 * How much larger a PNG may be and still be preferred.
 *
 * PNG is lossless and these images carry Arabic text that JPEG rings, so a
 * slightly bigger lossless file is the better answer, not a worse one. Only a
 * clear size loss buys the quality loss.
 */
const PNG_SIZE_TOLERANCE = 1.2;

/**
 * Copy one pixmap's COLOUR components into another, ignoring alpha on both.
 * Strides are read rather than assumed: mupdf pads rows on some layouts.
 */
function copyColorPlanes(src, dst) {
  const w = src.getWidth(), h = src.getHeight();
  const sn = src.getNumberOfComponents(), ss = src.getStride(), sp = src.getPixels();
  const dn = dst.getNumberOfComponents(), ds = dst.getStride(), dp = dst.getPixels();
  const cols = sn - (src.getAlpha() ? 1 : 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const so = y * ss + x * sn, dof = y * ds + x * dn;
      for (let c = 0; c < cols; c++) dp[dof + c] = sp[so + c];
    }
  }
}

/**
 * THE IMAGE'S PIXELS WITH THE ALPHA ITS SOFT MASK CARRIES.
 *
 * `image.toPixmap()` returns the BASE image only. MuPDF keeps an /SMask on the
 * image and applies it when it composites, so anything that decodes a pixmap and
 * ships it — which is what this file does — ships the picture without its
 * transparency.
 *
 * MEASURED, `Presentation 7 (MH).pdf` p1. PowerPoint exports a title carrying a
 * text shadow as a 1026x266 image whose colour data has NO non-black pixel at
 * all (0 of 272916) and whose entire shape lives in an /SMask. Dropping the mask
 * therefore did not soften the shadow — it painted a solid opaque black
 * rectangle across the title, on 41 of 41 slides.
 *
 * Over the frozen benchmark corpus: 197 of 478 placed images carry such a mask,
 * every one of them the same pixel dimensions as its base, none of them a
 * stencil, and 55 of them black to the last pixel like the one above.
 *
 * The stencil /Mask case is deliberately NOT handled here. Its convention is the
 * opposite (a set sample means "do not paint"), and MuPDF routes it through
 * `clipImageMask` rather than through an image's alpha; writing it into alpha
 * would invert it. There are none in this corpus and there is no evidence to
 * design against, so it is left exactly as it was.
 */
function pixmapWithSoftMask(image) {
  let mask = null;
  try { mask = image.getMask?.() ?? null; } catch { mask = null; }
  const base = image.toPixmap();
  if (!mask || mask.getImageMask?.()) { release(mask); return base; }

  let mp = null, cs = null, out = base;
  try {
    mp = mask.toPixmap();
    if (mp.getWidth() !== base.getWidth() || mp.getHeight() !== base.getHeight()) return base;
    // 18 of the 197 arrive with no alpha channel to write into; those get a
    // fresh pixmap that has one, and the old one is dropped here rather than
    // left for the finalizer (see mupdf-lifetime.js).
    if (!base.getAlpha()) {
      cs = base.getColorSpace();
      out = new mupdf.Pixmap(cs, base.getBounds(), true);
      copyColorPlanes(base, out);
      base.destroy?.();
    }
    const w = out.getWidth(), h = out.getHeight();
    const n = out.getNumberOfComponents(), stride = out.getStride(), px = out.getPixels();
    const mn = mp.getNumberOfComponents(), ms = mp.getStride(), mx = mp.getPixels();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) px[y * stride + x * n + n - 1] = mx[y * ms + x * mn];
    }
    return out;
  } finally {
    release(mp, cs, mask);
  }
}

/** Is every colour sample in a pixmap zero, ignoring any alpha component? */
function pixmapIsFullyBlack(pm) {
  const n = pm.getNumberOfComponents();
  const colors = n - (pm.getAlpha() ? 1 : 0);
  const stride = pm.getStride(), pixels = pm.getPixels();
  const w = pm.getWidth(), h = pm.getHeight();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const offset = y * stride + x * n;
      for (let c = 0; c < colors; c++) if (pixels[offset + c] !== 0) return false;
    }
  }
  return true;
}

/**
 * Count placed page images with the same mask-definition boundary used by
 * `extractVectors`, without paying its encoding and vector-rasterisation cost.
 * Exported for the frozen-corpus regression test.
 */
export function scanPageImageCensus(page) {
  const census = { placed: 0, softMasked: 0, fullyBlackBase: 0 };
  let maskDepth = 0;

  const record = (image) => {
    if (maskDepth > 0) { release(image); return; }
    census.placed++;
    let mask = null, base = null;
    try {
      try { mask = image.getMask?.() ?? null; } catch { mask = null; }
      const softMasked = !!mask && !mask.getImageMask?.();
      if (!softMasked) return;
      census.softMasked++;
      base = image.toPixmap();
      if (pixmapIsFullyBlack(base)) census.fullyBlackBase++;
    } finally {
      release(base, mask, image);
    }
  };

  const device = new mupdf.Device({
    fillImage: record,
    // A stencil painted through `fillImageMask` has no base image that can carry
    // an /SMask, so it is outside this base-image census.
    fillImageMask(image, _ctm, colorspace) { release(image, colorspace); },
    fillPath(path, _evenOdd, _ctm, colorspace) { release(path, colorspace); },
    strokePath(path, stroke, _ctm, colorspace) { release(path, stroke, colorspace); },
    clipPath(path) { release(path); },
    clipStrokePath(path, stroke) { release(path, stroke); },
    fillText(text, _ctm, colorspace) { release(text, colorspace); },
    strokeText(text, stroke, _ctm, colorspace) { release(text, stroke, colorspace); },
    clipText(text) { release(text); },
    clipStrokeText(text, stroke) { release(text, stroke); },
    ignoreText(text) { release(text); },
    fillShade(shade) { detachBorrowed(shade); },
    clipImageMask(image) { release(image); },
    popClip() {},
    beginMask() { maskDepth++; },
    endMask() { maskDepth = Math.max(0, maskDepth - 1); },
    beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {},
    close() {}, drop() {},
  });

  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    release(device);
  }
  return census;
}

/**
 * Decode a placed image to bytes the rest of the pipeline can carry.
 *
 * Taken HERE, inside the device callback, because that is where the mupdf Image
 * handle is guaranteed to be alive — storing the handle and decoding later means
 * holding a WASM pointer across the page's lifetime, which this project has
 * already seen end in a double-free inside a GC finalizer.
 *
 * Format is chosen, not fixed. PNG is lossless and ruinous for photographs: one
 * 1536x1024 slide illustration is 1.8MB as PNG, so a deck of them would ship at
 * 50MB. Anything opaque and large becomes JPEG; transparency always keeps PNG,
 * because there is no lossy format here that preserves an alpha channel.
 */
function encodeImage(image) {
  const pm = pixmapWithSoftMask(image);
  try {
    // No colourspace means a stencil mask's 1-bit pixmap: PNG is the only
    // encoder that can carry it at all, and the fill colour is applied by the
    // caller's own record rather than baked in here.
    if (pm.getAlpha() > 0 || pm.getColorSpace() == null) {
      return { bytes: Buffer.from(pm.asPNG()), format: "png" };
    }
    const jpeg = Buffer.from(pm.asJPEG(90, false));
    const worthComparing =
      pm.getNumberOfComponents() <= PNG_COMPARISON_COMPONENTS ||
      pm.getWidth() * pm.getHeight() <= PNG_COMPARISON_PIXELS;
    if (worthComparing) {
      const png = Buffer.from(pm.asPNG());
      if (png.length <= jpeg.length * PNG_SIZE_TOLERANCE) return { bytes: png, format: "png" };
    }
    return { bytes: jpeg, format: "jpeg" };
  } finally {
    pm.destroy?.();
  }
}

/** Target width for a raster fallback when a PDF shade is a real gradient. */
const SHADE_RASTER_WIDTH = 1400;
/** Complex paths are rendered at two pixels per source point (144 dpi). */
const VECTOR_RASTER_SCALE = 2;

/**
 * Replay one page into a transparent draw surface, forwarding graphics state
 * and masks but painting only one visible shade.
 *
 * MuPDF's Shade wrapper exposes no stops or colours, only `fillShade`. Dropping
 * it therefore dropped visible ink. Replaying through MuPDF's own DrawDevice is
 * the exact fallback: flat shades are recognised from the pixels and promoted
 * back to an editable rectangle; a real gradient remains a transparent PNG.
 */
function rasterizeShade(page, targetIndex) {
  const [x0, y0, x1, y1] = page.getBounds();
  const widthPt = x1 - x0, heightPt = y1 - y0;
  const scale = Math.min(2, SHADE_RASTER_WIDTH / Math.max(widthPt, 1));
  const widthPx = Math.max(1, Math.ceil(widthPt * scale));
  const heightPx = Math.max(1, Math.ceil(heightPt * scale));
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, widthPx, heightPx], true);
  pixmap.clear();
  const draw = new mupdf.DrawDevice([scale, 0, 0, scale, -x0 * scale, -y0 * scale], pixmap);
  let device = null;
  let maskDepth = 0;
  let visibleShade = 0;
  let painted = false;

  // Mask definitions must be painted into the draw device even though ordinary
  // page ink is ignored; endMask turns that definition into the clip governing
  // the target shade.
  const inMask = () => maskDepth > 0;
  device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.fillPath(path, evenOdd, ctm, colorspace, color, alpha); }
      finally { release(path, colorspace); }
    },
    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.strokePath(path, stroke, ctm, colorspace, color, alpha); }
      finally { release(path, stroke, colorspace); }
    },
    clipPath(path, evenOdd, ctm) {
      try { draw.clipPath(path, evenOdd, ctm); } finally { release(path); }
    },
    clipStrokePath(path, stroke, ctm) {
      try { draw.clipStrokePath(path, stroke, ctm); } finally { release(path, stroke); }
    },
    fillText(text, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.fillText(text, ctm, colorspace, color, alpha); }
      finally { release(text, colorspace); }
    },
    strokeText(text, stroke, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.strokeText(text, stroke, ctm, colorspace, color, alpha); }
      finally { release(text, stroke, colorspace); }
    },
    clipText(text, ctm) {
      try { draw.clipText(text, ctm); } finally { release(text); }
    },
    clipStrokeText(text, stroke, ctm) {
      try { draw.clipStrokeText(text, stroke, ctm); } finally { release(text, stroke); }
    },
    ignoreText(text) { release(text); },
    fillShade(shade, ctm, alpha) {
      try {
        if (inMask()) draw.fillShade(shade, ctm, alpha);
        else {
          if (visibleShade === targetIndex) { draw.fillShade(shade, ctm, alpha); painted = true; }
          visibleShade++;
        }
      } finally { detachBorrowed(shade); }
    },
    fillImage(image, ctm, alpha) {
      try { if (inMask()) draw.fillImage(image, ctm, alpha); } finally { release(image); }
    },
    fillImageMask(image, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.fillImageMask(image, ctm, colorspace, color, alpha); }
      finally { release(image, colorspace); }
    },
    clipImageMask(image, ctm) {
      try { draw.clipImageMask(image, ctm); } finally { release(image); }
    },
    popClip() { draw.popClip(); },
    beginMask(area, luminosity, colorspace, color) {
      try { draw.beginMask(area, luminosity, colorspace, color); }
      finally { release(colorspace); }
      maskDepth++;
    },
    endMask() { draw.endMask(); maskDepth = Math.max(0, maskDepth - 1); },
    beginGroup(area, colorspace, isolated, knockout, blendmode, alpha) {
      try { draw.beginGroup(area, colorspace, isolated, knockout, blendmode, alpha); }
      finally { release(colorspace); }
    },
    endGroup() { draw.endGroup(); },
    beginTile(area, view, xstep, ystep, ctm, id, docId) {
      return draw.beginTile(area, view, xstep, ystep, ctm, id, docId);
    },
    endTile() { draw.endTile(); },
    beginLayer(name) { draw.beginLayer(name); },
    endLayer() { draw.endLayer(); },
    close() {}, drop() {},
  });

  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
    draw.close();
    if (!painted) return null;

    const pixels = pixmap.getPixels();
    const components = pixmap.getNumberOfComponents();
    const alphaAt = components - 1;
    let minX = widthPx, minY = heightPx, maxX = -1, maxY = -1, ink = 0;
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, core = 0;
    for (let py = 0; py < heightPx; py++) {
      for (let px = 0; px < widthPx; px++) {
        const i = (py * widthPx + px) * components;
        const alpha = pixels[i + alphaAt];
        if (!alpha) continue;
        ink++;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (alpha < 250) continue;
        core++;
        rMin = Math.min(rMin, pixels[i]); rMax = Math.max(rMax, pixels[i]);
        gMin = Math.min(gMin, pixels[i + 1]); gMax = Math.max(gMax, pixels[i + 1]);
        bMin = Math.min(bMin, pixels[i + 2]); bMax = Math.max(bMax, pixels[i + 2]);
      }
    }
    if (!ink) return null;
    const boxPixels = (maxX - minX + 1) * (maxY - minY + 1);
    const rectangular = ink / boxPixels >= 0.995;
    const flat = rectangular && core > 0 && rMax - rMin <= 1 && gMax - gMin <= 1 && bMax - bMin <= 1;
    const bbox = {
      x0: x0 + minX / scale,
      y0: y0 + minY / scale,
      x1: x0 + (maxX + 1) / scale,
      y1: y0 + (maxY + 1) / scale,
      w: (maxX - minX + 1) / scale,
      h: (maxY - minY + 1) / scale,
    };
    const color = [rMin, gMin, bMin].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
    return {
      bbox,
      // The PNG still has the full transparent page canvas. Placing it at the
      // ink bbox would scale the whole page down into that box (measured on the
      // field PDF's callout shadows), so raster shades use the page frame while
      // flat shades can still be promoted at their tight ink bbox.
      imageBbox: { x0, y0, x1, y1, w: widthPt, h: heightPt },
      flatColor: flat ? color : null,
      bytes: flat ? null : Buffer.from(pixmap.asPNG()),
      widthPx,
      heightPx,
    };
  } finally {
    release(device, draw, pixmap);
  }
}

/**
 * Render one non-preset path through MuPDF while preserving the page's active
 * clips, masks and groups.
 *
 * A bounding rectangle is not a fallback for a polygon or Bézier path. It is a
 * different shape, and on charts it can cover most of the plot. PowerPoint has
 * no reliable PptxGenJS primitive for these PDF paths, so preserve their exact
 * pixels in a small transparent PNG. Text and ordinary rectangles remain fully
 * editable; only the path PowerPoint cannot represent is rasterized.
 */
function rasterizeVector(page, target) {
  const [pageX0, pageY0, pageX1, pageY1] = page.getBounds();
  const padPt = Math.max(1.5, (target.strokeWidth ?? 0) / 2 + 1);
  const x0 = Math.max(pageX0, target.bbox.x0 - padPt);
  const y0 = Math.max(pageY0, target.bbox.y0 - padPt);
  const x1 = Math.min(pageX1, target.bbox.x1 + padPt);
  const y1 = Math.min(pageY1, target.bbox.y1 + padPt);
  if (!(x1 > x0 && y1 > y0)) return null;

  const widthPx = Math.max(1, Math.ceil((x1 - x0) * VECTOR_RASTER_SCALE));
  const heightPx = Math.max(1, Math.ceil((y1 - y0) * VECTOR_RASTER_SCALE));
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, widthPx, heightPx], true);
  pixmap.clear();
  const plainPixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, widthPx, heightPx], true);
  plainPixmap.clear();
  const draw = new mupdf.DrawDevice(
    [VECTOR_RASTER_SCALE, 0, 0, VECTOR_RASTER_SCALE, -x0 * VECTOR_RASTER_SCALE, -y0 * VECTOR_RASTER_SCALE],
    pixmap
  );
  const plainDraw = new mupdf.DrawDevice(
    [VECTOR_RASTER_SCALE, 0, 0, VECTOR_RASTER_SCALE, -x0 * VECTOR_RASTER_SCALE, -y0 * VECTOR_RASTER_SCALE],
    plainPixmap
  );
  let device = null;
  let maskDepth = 0;
  let pathIndex = 0;
  let painted = false;
  const inMask = () => maskDepth > 0;

  device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, colorspace, color, alpha) {
      const current = pathIndex++;
      try {
        if (inMask() || current === target.pathIndex) {
          draw.fillPath(path, evenOdd, ctm, colorspace, color, alpha);
          if (!inMask() && current === target.pathIndex) {
            plainDraw.fillPath(path, evenOdd, ctm, colorspace, color, alpha);
            painted = true;
          }
        }
      } finally { release(path, colorspace); }
    },
    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      const current = pathIndex++;
      try {
        if (inMask() || current === target.pathIndex) {
          draw.strokePath(path, stroke, ctm, colorspace, color, alpha);
          if (!inMask() && current === target.pathIndex) {
            plainDraw.strokePath(path, stroke, ctm, colorspace, color, alpha);
            painted = true;
          }
        }
      } finally { release(path, stroke, colorspace); }
    },
    clipPath(path, evenOdd, ctm) {
      try { draw.clipPath(path, evenOdd, ctm); } finally { release(path); }
    },
    clipStrokePath(path, stroke, ctm) {
      try { draw.clipStrokePath(path, stroke, ctm); } finally { release(path, stroke); }
    },
    fillText(text, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.fillText(text, ctm, colorspace, color, alpha); }
      finally { release(text, colorspace); }
    },
    strokeText(text, stroke, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.strokeText(text, stroke, ctm, colorspace, color, alpha); }
      finally { release(text, stroke, colorspace); }
    },
    clipText(text, ctm) {
      try { draw.clipText(text, ctm); } finally { release(text); }
    },
    clipStrokeText(text, stroke, ctm) {
      try { draw.clipStrokeText(text, stroke, ctm); } finally { release(text, stroke); }
    },
    ignoreText(text) { release(text); },
    fillShade(shade, ctm, alpha) {
      try { if (inMask()) draw.fillShade(shade, ctm, alpha); }
      finally { detachBorrowed(shade); }
    },
    fillImage(image, ctm, alpha) {
      try { if (inMask()) draw.fillImage(image, ctm, alpha); } finally { release(image); }
    },
    fillImageMask(image, ctm, colorspace, color, alpha) {
      try { if (inMask()) draw.fillImageMask(image, ctm, colorspace, color, alpha); }
      finally { release(image, colorspace); }
    },
    clipImageMask(image, ctm) {
      try { draw.clipImageMask(image, ctm); } finally { release(image); }
    },
    popClip() { draw.popClip(); },
    beginMask(area, luminosity, colorspace, color) {
      try { draw.beginMask(area, luminosity, colorspace, color); }
      finally { release(colorspace); }
      maskDepth++;
    },
    endMask() { draw.endMask(); maskDepth = Math.max(0, maskDepth - 1); },
    beginGroup(area, colorspace, isolated, knockout, blendmode, alpha) {
      try {
        draw.beginGroup(area, colorspace, isolated, knockout, blendmode, alpha);
        plainDraw.beginGroup(area, colorspace, isolated, knockout, blendmode, alpha);
      }
      finally { release(colorspace); }
    },
    endGroup() { draw.endGroup(); plainDraw.endGroup(); },
    beginTile(area, view, xstep, ystep, ctm, id, docId) {
      const result = draw.beginTile(area, view, xstep, ystep, ctm, id, docId);
      plainDraw.beginTile(area, view, xstep, ystep, ctm, id, docId);
      return result;
    },
    endTile() { draw.endTile(); plainDraw.endTile(); },
    beginLayer(name) { draw.beginLayer(name); plainDraw.beginLayer(name); },
    endLayer() { draw.endLayer(); plainDraw.endLayer(); },
    close() {}, drop() {},
  });

  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
    draw.close();
    plainDraw.close();
    if (!painted) return null;
    const pixels = pixmap.getPixels();
    const plainPixels = plainPixmap.getPixels();
    const components = pixmap.getNumberOfComponents();
    const alphaAt = components - 1;
    let hasInk = false;
    for (let i = alphaAt; i < pixels.length; i += components) {
      if (pixels[i]) { hasInk = true; break; }
    }
    let clipChanged = pixels.length !== plainPixels.length;
    if (!clipChanged) {
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== plainPixels[i]) { clipChanged = true; break; }
      }
    }
    return {
      bbox: { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 },
      bytes: Buffer.from(pixmap.asPNG()),
      widthPx,
      heightPx,
      hasInk,
      clipChanged,
    };
  } finally {
    release(device, draw, plainDraw, pixmap, plainPixmap);
  }
}

/** Flatten a Path into transformed subpaths of points, noting any curves. */
function readPath(path, ctm) {
  const subpaths = [];
  let cur = null;
  let hasCurve = false;

  path.walk({
    moveTo(x, y) {
      cur = { points: [tx(ctm, x, y)], closed: false };
      subpaths.push(cur);
    },
    lineTo(x, y) {
      if (cur) cur.points.push(tx(ctm, x, y));
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      hasCurve = true;
      if (!cur) return;
      // Keep the control points so an ellipse can still be recognised, but flag
      // the subpath so we never claim a curved shape is a polygon.
      cur.curved = true;
      cur.points.push(tx(ctm, x1, y1), tx(ctm, x2, y2), tx(ctm, x3, y3));
    },
    closePath() {
      if (cur) cur.closed = true;
    },
  });

  return { subpaths, hasCurve };
}

function boundsOf(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) {
    for (const [x, y] of sp.points) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * Classify a path into something PowerPoint has a native primitive for.
 * Anything we cannot prove is one of these stays "complex" and will be handled
 * by a fallback rather than approximated into the wrong shape.
 */
function classify(subpaths, hasCurve, b) {
  if (subpaths.length !== 1) return "complex";
  const sp = subpaths[0];
  const pts = dedupe(sp.points);

  // A degenerate box is a rule/underline: PowerPoint draws these better as a
  // line than as a 0.4pt-tall rectangle.
  if (!hasCurve && pts.length === 2) return "line";
  if (!hasCurve && (b.h <= EPS || b.w <= EPS)) return "line";

  if (!hasCurve && (pts.length === 4 || pts.length === 5)) {
    return isAxisAlignedRect(pts, b) ? "rect" : "quad";
  }
  if (hasCurve && looksElliptical(pts, b)) return "ellipse";
  if (hasCurve && looksRounded(pts, b)) return "roundRect";
  if (!hasCurve && pts.length <= 12) return "polygon";
  return "complex";
}

/**
 * A rounded rectangle: straight runs along all four edges, curves only at the
 * corners. Detected by requiring at least two points to lie exactly on each
 * edge — a plain ellipse touches each edge only once, and a free-form path
 * generally touches some edges not at all.
 */
function looksRounded(pts, b) {
  if (b.w <= EPS || b.h <= EPS || pts.length < 8) return false;
  const on = (v, edge) => Math.abs(v - edge) <= EPS;
  const left = pts.filter(([x]) => on(x, b.x0)).length;
  const right = pts.filter(([x]) => on(x, b.x1)).length;
  const top = pts.filter(([, y]) => on(y, b.y0)).length;
  const bottom = pts.filter(([, y]) => on(y, b.y1)).length;
  return left >= 2 && right >= 2 && top >= 2 && bottom >= 2;
}

/**
 * Corner radius of a rounded rectangle, in points: how far along the top edge
 * the straight run begins.
 */
export function cornerRadius(pts, b) {
  const onTop = pts.filter(([, y]) => Math.abs(y - b.y0) <= EPS).map(([x]) => x).sort((a, z) => a - z);
  if (!onTop.length) return 0;
  return Math.max(0, Math.min(onTop[0] - b.x0, b.x1 - onTop[onTop.length - 1]));
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) out.push(p);
  }
  // Drop a closing point that repeats the first.
  if (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.abs(a[0] - z[0]) <= EPS && Math.abs(a[1] - z[1]) <= EPS) out.pop();
  }
  return out;
}

function isAxisAlignedRect(pts, b) {
  if (pts.length !== 4) return false;
  return pts.every(
    ([x, y]) =>
      (Math.abs(x - b.x0) <= EPS || Math.abs(x - b.x1) <= EPS) &&
      (Math.abs(y - b.y0) <= EPS || Math.abs(y - b.y1) <= EPS)
  );
}

/** Every point within tolerance of the bbox's inscribed ellipse. */
function looksElliptical(pts, b) {
  if (b.w <= EPS || b.h <= EPS || pts.length < 4) return false;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const rx = b.w / 2, ry = b.h / 2;
  const tol = 0.12;
  return pts.every(([x, y]) => {
    const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
    return Math.abs(d - 1) <= tol;
  });
}

/**
 * A filled even-odd path made from an outer rectangle and an inset rounded
 * rectangle is a hollow frame, not a solid box. The 118-page field document has
 * eleven of these (the outlined lesson buttons on pages 64 and 79); flattening
 * `complex` to its bbox turned every one into an opaque teal/gold slab.
 *
 * Return the equivalent editable PowerPoint stroke only for that narrow,
 * measurable topology. Everything else remains complex rather than borrowing
 * this approximation.
 */
function compoundFrame(subpaths, evenOdd) {
  if (!evenOdd || subpaths.length !== 2) return null;
  const ranked = subpaths
    .map((subpath) => ({ subpath, bbox: boundsOf([subpath]), points: dedupe(subpath.points) }))
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  const [outer, inner] = ranked;
  if (!outer.subpath.closed || !inner.subpath.closed) return null;
  if (!isAxisAlignedRect(outer.points, outer.bbox)) return null;
  if (!inner.subpath.curved || !looksRounded(inner.points, inner.bbox)) return null;

  const insets = [
    inner.bbox.x0 - outer.bbox.x0,
    outer.bbox.x1 - inner.bbox.x1,
    inner.bbox.y0 - outer.bbox.y0,
    outer.bbox.y1 - inner.bbox.y1,
  ];
  const minInset = Math.min(...insets), maxInset = Math.max(...insets);
  if (minInset <= EPS || maxInset > 6 || maxInset > Math.min(outer.bbox.w, outer.bbox.h) * 0.2) return null;
  if (maxInset / minInset > 2.5) return null;

  const strokeWidth = insets.reduce((a, b) => a + b, 0) / insets.length;
  const bbox = {
    x0: (outer.bbox.x0 + inner.bbox.x0) / 2,
    y0: (outer.bbox.y0 + inner.bbox.y0) / 2,
    x1: (outer.bbox.x1 + inner.bbox.x1) / 2,
    y1: (outer.bbox.y1 + inner.bbox.y1) / 2,
  };
  bbox.w = bbox.x1 - bbox.x0;
  bbox.h = bbox.y1 - bbox.y0;

  return {
    bbox,
    subpaths: [inner.subpath],
    strokeWidth: +strokeWidth.toFixed(3),
    cornerRadiusPt: +(cornerRadius(inner.points, inner.bbox) + strokeWidth / 2).toFixed(3),
  };
}

/**
 * A device colour, read THROUGH its colorspace.
 *
 * MuPDF hands a device one component per COLORSPACE component — DeviceGray is 1,
 * DeviceRGB is 3, DeviceCMYK is 4 — and this function used to open by slicing
 * three off the front and calling them R, G and B. The corpus never showed it:
 * 28 Chrome prints of one HTML template are DeviceRGB from end to end (measured,
 * `experiments/probe-colorspaces.js`: 16501 device colours on Chp1-Lec6-2, all
 * DeviceRGB). Every other producer on this machine is majority DeviceGray:
 *
 *   Microsoft Word            98% of device colours gray   (1513 of 1547)
 *   pdfTeX / LaTeX            97%                          (6655 of 6834)
 *   PowerPoint (three decks)  54-79%
 *   Adobe Illustrator         609 colours, all DeviceCMYK
 *
 * The two failures are not equally visible, and the quiet one is worse:
 *
 *   1 component   `[1]` (white) produced the TWO-character string "FF".
 *                 pptxgenjs refuses anything that is not 6 hex digits, warns on
 *                 the console and substitutes 000000 — so every white and every
 *                 grey shipped BLACK. 839 white fills across six foreign files.
 *   4 components  the slice took C, M, Y and dropped K, then printed them as
 *                 R, G, B. That IS six digits, so nothing warned anywhere:
 *                 Illustrator's `[0,0,0,0.2]` — a 20% grey — shipped as pure
 *                 black, and a cyan would have shipped red.
 *
 * The colorspace's own predicates decide, not the component count, because a
 * count cannot tell DeviceGray from a 1-ink Separation (EVO-021: believe what the
 * object declares about itself, not what its shape suggests). The count is only
 * the fallback, and its job there is narrower — guarantee six characters, so a
 * space we do not model degrades to a wrong colour rather than to a black one.
 */
function toHex(colorspace, color) {
  const c = Array.isArray(color) ? color : [];
  let gray = false, rgb = false, cmyk = false;
  // The colorspace is a borrowed WASM object; asking a released one throws.
  // Every caller reads the colour before its `release(...)`, and this guard is
  // for the paths where MuPDF passes no colorspace at all.
  try { gray = !!colorspace?.isGray?.(); rgb = !!colorspace?.isRGB?.(); cmyk = !!colorspace?.isCMYK?.(); }
  catch { /* fall through to the component count */ }

  let triple;
  if (gray || (!rgb && !cmyk && c.length === 1)) triple = [c[0], c[0], c[0]];
  else if (cmyk || (!rgb && c.length === 4)) {
    const [cy, m, y, k] = c;
    triple = [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  else if (c.length >= 3) triple = [c[0], c[1], c[2]];
  else triple = [0, 0, 0];

  return triple
    .map((v) => Math.round(Math.max(0, Math.min(1, v || 0)) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Extract every painted vector and image on a page.
 * @returns {{vectors:Array, images:Array, unsupported:Array}}
 */
export function extractVectors(page) {
  const vectors = [];
  const images = [];
  const notes = [];
  const textPaints = [];
  let seq = 0;
  // Stable callback ordinal used by the isolated path raster replay below.
  let pathIndex = 0;
  const clipStack = [];
  const maskAreas = [];
  const containsBox = (outer, inner, inset = 0) => outer &&
    outer.x0 <= inner.x0 - inset && outer.y0 <= inner.y0 - inset &&
    outer.x1 >= inner.x1 + inset && outer.y1 >= inner.y1 + inset;
  // A page-sized rectangular clip changes nothing. A tighter rectangle clips
  // only when it actually intersects the path; a curved/text/mask clip is safe
  // to ignore only when the target sits clearly inside its bounding box.
  const clipAffects = (bbox) => clipStack.some((clip) => {
    if (clip.softMask || !clip.bbox) return true;
    return clip.axisRect
      ? !containsBox(clip.bbox, bbox)
      : !containsBox(clip.bbox, bbox, 1);
  });
  // How much of a placed rectangle SURVIVES the clip stack.
  //
  // `clipAffects` answers "is this clipped at all", which is all a vector needs
  // — its subpaths are already the drawn geometry. An IMAGE is different: the
  // page places a big picture and clips it to a small frame, and the placement
  // rectangle is the whole picture, not the part you can see. Emitting the
  // placement is how four photo cards became seven with one off the slide.
  //
  // Every clip contributes its BOUNDING BOX. For a curved or text clip that is
  // an over-estimate of the real clip, so the result is never tighter than the
  // truth — strictly closer than ignoring it. Returns null when the clip leaves
  // nothing, which the caller turns into a degenerate (declared) image rather
  // than a silent drop.
  const CLIP_EPS = 0.5;
  const visibleAfterClip = (bbox) => {
    let { x0, y0, x1, y1 } = bbox;
    for (const clip of clipStack) {
      if (!clip.bbox) continue;
      x0 = Math.max(x0, clip.bbox.x0); y0 = Math.max(y0, clip.bbox.y0);
      x1 = Math.min(x1, clip.bbox.x1); y1 = Math.min(y1, clip.bbox.y1);
    }
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  };
  /** Did the clip actually take a meaningful bite out of this rectangle? */
  const clipTightens = (placed, visible) => !visible ||
    visible.x0 > placed.x0 + CLIP_EPS || visible.y0 > placed.y0 + CLIP_EPS ||
    visible.x1 < placed.x1 - CLIP_EPS || visible.y1 < placed.y1 - CLIP_EPS;
  // Cropping a rotated or skewed placement to an axis-aligned sub-rectangle
  // would show the wrong pixels, so those keep today's behaviour and say so.
  const axisAlignedCtm = (ctm) => Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6;
  /**
   * What the clip stack does to one placed image, as fields on its record.
   *
   * `visibleBbox` is present only when the clip genuinely tightens the
   * placement, so a document that never clips its images (every Chrome print in
   * the corpus) produces byte-identical records. `clipUnappliable` marks the
   * rotated/skewed placements this cannot crop, so they are countable rather
   * than invisible.
   */
  const clipReport = (placed, ctm) => {
    const visible = visibleAfterClip(placed);
    if (!clipTightens(placed, visible)) return {};
    // An image the clip removes ENTIRELY paints nothing, and that is true
    // whatever its transform — so emptiness is decided before rotation is.
    if (!visible) return { visibleBbox: null };
    if (!axisAlignedCtm(ctm)) return { clipUnappliable: true };
    return { visibleBbox: visible };
  };
  // Everything drawn between beginMask and endMask DEFINES a soft mask; it is
  // not ink on the page. Measured on test.pdf p0, the sequence is
  //
  //   beginMask · fillImage 2561x2334 greyscale · endMask · fillShade
  //
  // — the image is the alpha channel of the gradient that follows it, and the
  // gradient is the purple hero card. Emitting the mask as a picture paints an
  // opaque black slab exactly where the card should be, which is how the first
  // version of image support rendered this deck.
  let maskDepth = 0;
  /** Drawings consumed as mask definitions, so the page can be honest about them. */
  let masksDefined = 0;
  /** Mask-clips pushed by endMask and not yet popped: content here is masked. */
  let pendingMaskClips = 0;

  // One unreadable image must not cost the page every other thing on it, but it
  // must not vanish quietly either: the failure travels with the record and the
  // coverage ledger turns it into an error.
  // Decoding a large image occasionally throws from inside the WASM allocator
  // ("table index is out of bounds", "zlib error") on a heavy page, and the same
  // image decodes perfectly on its own a moment later — it is pressure, not a
  // bad image. Measured on test.pdf p12: one 2561x2335 page image failed during
  // a full conversion and succeeded in isolation, twice.
  //
  // So retry before believing it. An image that still will not decode after
  // DECODE_ATTEMPTS keeps its error and becomes a coverage failure, because the
  // one thing that must never happen is the picture quietly not being there.
  const DECODE_ATTEMPTS = 3;
  const decoded = (image) => {
    let last = null;
    try {
      for (let attempt = 1; attempt <= DECODE_ATTEMPTS; attempt++) {
        try { return encodeImage(image); }
        catch (e) { last = e; }
      }
      return { bytes: null, format: null,
        decodeError: `${String(last?.message || last)} (${DECODE_ATTEMPTS} attempts)` };
    } finally { release(image); }
  };

  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, colorspace, color, alpha) {
      const currentPathIndex = pathIndex++;
      if (maskDepth > 0) { seq++; release(path, colorspace); return; }
      // BEFORE the release below: `toHex` reads the colorspace, and a released
      // one cannot answer.
      const hex = toHex(colorspace, color);
      const { subpaths, hasCurve } = readPath(path, ctm);
      release(path, colorspace);
      if (!subpaths.length) return;
      const b = boundsOf(subpaths);
      if (!isFinite(b.w) || b.w < 0 || b.h < 0) return;
      const frame = compoundFrame(subpaths, evenOdd);
      if (frame) {
        const clipped = clipAffects(frame.bbox);
        vectors.push({
          kind: "stroke",
          shape: "roundRect",
          paintSeq: seq++,
          bbox: frame.bbox,
          subpaths: frame.subpaths,
          hasCurve: true,
          stroke: hex,
          strokeWidth: frame.strokeWidth,
          cornerRadiusPt: frame.cornerRadiusPt,
          dashes: [],
          alpha,
          clipped,
          clipDepth: clipStack.length,
          compoundFrame: true,
          pathIndex: currentPathIndex,
          reconstructionStrategy: "native_shape",
        });
        return;
      }
      const clipped = clipAffects(b);
      vectors.push({
        kind: "fill",
        shape: classify(subpaths, hasCurve, b),
        paintSeq: seq++,
        bbox: b,
        subpaths,
        hasCurve,
        evenOdd,
        fill: hex,
        alpha,
        clipped,
        clipDepth: clipStack.length,
        pathIndex: currentPathIndex,
      });
    },

    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      const currentPathIndex = pathIndex++;
      if (maskDepth > 0) { seq++; release(path, stroke, colorspace); return; }
      const hex = toHex(colorspace, color);      // before the release below
      const { subpaths, hasCurve } = readPath(path, ctm);
      // Stroke width is in path space; scale it by the transform.
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
      const strokeWidth = +(stroke.getLineWidth() * scale).toFixed(3);
      const dashes = stroke.getDashes();
      release(path, stroke, colorspace);
      if (!subpaths.length) return;
      const b = boundsOf(subpaths);
      if (!isFinite(b.w)) return;
      const clipped = clipAffects(b);
      vectors.push({
        kind: "stroke",
        shape: classify(subpaths, hasCurve, b),
        paintSeq: seq++,
        bbox: b,
        subpaths,
        hasCurve,
        stroke: hex,
        strokeWidth,
        dashes,
        alpha,
        clipped,
        clipDepth: clipStack.length,
        pathIndex: currentPathIndex,
      });
    },

    fillImage(image, ctm, alpha) {
      if (maskDepth > 0) { seq++; masksDefined++; release(image); return; }
      // The unit square maps through ctm to the placed rectangle.
      const corners = [tx(ctm, 0, 0), tx(ctm, 1, 0), tx(ctm, 1, 1), tx(ctm, 0, 1)];
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      const placed = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
                       w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      images.push({
        paintSeq: seq++,
        bbox: placed,
        ...clipReport(placed, ctm),
        widthPx: image.getWidth(),
        heightPx: image.getHeight(),
        alpha,
        ctm: Array.from(ctm),
        ...decoded(image),
      });
    },

    fillImageMask(image, ctm, colorspace, color, alpha) {
      const hex = toHex(colorspace, color);      // before the release below
      release(colorspace);
      if (maskDepth > 0) { seq++; masksDefined++; release(image); return; }
      const corners = [tx(ctm, 0, 0), tx(ctm, 1, 0), tx(ctm, 1, 1), tx(ctm, 0, 1)];
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      const placed = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
                       w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      images.push({
        paintSeq: seq++, isMask: true, fill: hex,
        bbox: placed,
        ...clipReport(placed, ctm),
        widthPx: image.getWidth(), heightPx: image.getHeight(), alpha, ctm: Array.from(ctm),
        ...decoded(image),
      });
    },

    // Gradients have no PowerPoint primitive we can derive from a shade object
    // alone; record the region so coverage can account for it honestly.
    fillShade(shade, ctm, alpha) {
      detachBorrowed(shade);
      if (maskDepth > 0) { seq++; return; }
      notes.push({ type: "shade", shadeIndex: notes.length, paintSeq: seq++, alpha, masked: pendingMaskClips > 0 });
    },

    clipPath(path, evenOdd, ctm) {
      const { subpaths, hasCurve } = readPath(path, ctm);
      release(path);
      if (!subpaths.length) { clipStack.push({ bbox: null, axisRect: false }); return; }
      const bbox = boundsOf(subpaths);
      const points = subpaths.length === 1 ? dedupe(subpaths[0].points) : [];
      clipStack.push({
        bbox,
        axisRect: !evenOdd && !hasCurve && subpaths.length === 1 && isAxisAlignedRect(points, bbox),
      });
    },
    clipStrokePath(path, stroke, ctm) {
      const { subpaths } = readPath(path, ctm);
      release(path, stroke);
      clipStack.push({ bbox: subpaths.length ? boundsOf(subpaths) : null, axisRect: false });
    },
    clipText(text, ctm) {
      const b = text.getBounds(null, ctm);
      release(text);
      clipStack.push({ bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] }, axisRect: false });
    },
    clipImageMask(image, ctm) {
      const corners = [tx(ctm, 0, 0), tx(ctm, 1, 0), tx(ctm, 1, 1), tx(ctm, 0, 1)];
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      release(image);
      clipStack.push({
        bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        axisRect: false,
      });
    },
    popClip() {
      const clip = clipStack.pop();
      if (clip?.softMask) pendingMaskClips = Math.max(0, pendingMaskClips - 1);
    },

    // Text is rebuilt by the glyph extractor, but we still record WHEN it was
    // painted: vectors and glyphs come from two different walkers with separate
    // counters, so without this the z-order between a box and the text on it
    // would be an assumption rather than a fact.
    fillText(text, ctm, colorspace) {
      const b = text.getBounds(null, ctm);
      release(text, colorspace);
      textPaints.push({ paintSeq: seq++, bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } });
    },
    strokeText(text, stroke, ctm, colorspace) { release(text, stroke, colorspace); },
    ignoreText(text) { release(text); },

    // `endMask` does not just close the definition — it pushes the finished mask
    // as a clip, which stays active until the matching popClip. Content drawn in
    // that window is masked in the source and is NOT masked in our output, so it
    // is tracked rather than assumed away.
    beginMask(area) {
      maskDepth++;
      maskAreas.push(Array.isArray(area)
        ? { x0: area[0], y0: area[1], x1: area[2], y1: area[3] }
        : null);
    },
    endMask() {
      maskDepth = Math.max(0, maskDepth - 1);
      clipStack.push({ bbox: maskAreas.pop() ?? null, axisRect: false, softMask: true });
      pendingMaskClips++;
    },
    beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {},
    close() {}, drop() {},
  });

  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    release(device);
  }

  // PptxGenJS maps only preset geometries. Its previous fallback mapped every
  // freeform, polygon and quadrilateral to a rectangle, which is visibly false.
  // Preserve these paths as isolated transparent images at their true z-order.
  const [pageX0, pageY0, pageX1, pageY1] = page.getBounds();
  const pageArea = (pageX1 - pageX0) * (pageY1 - pageY0);
  const isFullPageFill = (v) => v.kind === "fill" && v.bbox.w * v.bbox.h >= pageArea * 0.98;
  for (const vector of vectors.filter((v) =>
    // A simple full-page fill can become the slide background. A complex path
    // merely has a huge pre-clip bbox; excluding it by area leaves real clipped
    // ink unsupported (two cover elements on the InDesign guide page 1).
    (!isFullPageFill(v) || ["complex", "polygon", "quad"].includes(v.shape)) &&
    ((v.clipped && !v.compoundFrame) || ["complex", "polygon", "quad"].includes(v.shape)))) {
    try {
      const raster = rasterizeVector(page, vector);
      if (!raster) continue;
      const freeform = ["complex", "polygon", "quad"].includes(vector.shape);
      if (!freeform && !raster.clipChanged) continue;
      vector.rasterized = true;
      vector.reconstructionStrategy = "rasterized_vector";
      images.push({
        paintSeq: vector.paintSeq,
        bbox: raster.bbox,
        widthPx: raster.widthPx,
        heightPx: raster.heightPx,
        alpha: 1,
        bytes: raster.bytes,
        format: "png",
        isVectorFallback: true,
        sourceType: "vector",
        reconstructionStrategy: "rasterized_vector",
      });
    } catch (err) {
      vector.rasterError = String(err?.message || err);
    }
  }

  for (const note of notes) {
    try {
      const raster = rasterizeShade(page, note.shadeIndex);
      if (!raster) continue;
      note.reconstructed = true;
      if (raster.flatColor) {
        vectors.push({
          kind: "fill", shape: "rect", paintSeq: note.paintSeq,
          bbox: raster.bbox, subpaths: [], hasCurve: false,
          fill: raster.flatColor, alpha: note.alpha, clipped: note.masked,
          sourceType: "shade", reconstructionStrategy: "native_shape",
        });
      } else {
        images.push({
          paintSeq: note.paintSeq, bbox: raster.imageBbox,
          widthPx: raster.widthPx, heightPx: raster.heightPx,
          // The alpha was already applied by MuPDF while producing the PNG.
          alpha: 1, bytes: raster.bytes, format: "png",
          isShade: true, sourceType: "shade", reconstructionStrategy: "rasterized_shade",
        });
      }
    } catch (err) {
      note.rasterError = String(err?.message || err);
    }
  }

  const unsupportedShades = notes.filter((n) => !n.reconstructed);
  return {
    vectors,
    images,
    textPaints,
    unsupported: unsupportedShades,
    // A fillShade callback is not necessarily visible ink. InDesign patterns
    // generate callbacks for clipped-away repetitions, and MuPDF's tile cache
    // can replay one logical shade for many callbacks. `rasterizeShade` runs the
    // exact page clip/mask stack; only a callback that produces pixels is a
    // source element the delivery ledger can meaningfully classify.
    shadeCount: notes.length - unsupportedShades.length,
    shadeCallbackCount: notes.length,
    shadeSkippedCount: unsupportedShades.length,
    masksDefined,
  };
}
