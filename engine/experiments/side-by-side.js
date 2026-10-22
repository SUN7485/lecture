/**
 * Composite SOURCE PDF page | OUR EXPORT into one PNG for visual comparison.
 * No text-drawing library needed — a thin coloured divider marks the seam,
 * and the caption on the sent file says which side is which.
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";
import { renderPdfPage } from "../src/render/compare.js";

const PDF = process.argv[2];
const PAGE = Number(process.argv[3]);
const PPTX_PNG = process.argv[4];
const OUT = process.argv[5];
const WIDTH = Number(process.argv[6] ?? 1000);

const src = renderPdfPage(PDF, PAGE, WIDTH);
const oursRaw = PNG.sync.read(fs.readFileSync(PPTX_PNG));

// Normalise both to RGBA at the same height.
const h = Math.max(src.height, oursRaw.height);
const DIVIDER = 6;
const out = new PNG({ width: src.width + DIVIDER + oursRaw.width, height: h });
out.data.fill(255);

const blit = (dst, dx, srcBuf, sw, sh, channels) => {
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const si = (y * sw + x) * channels;
      const di = (y * dst.width + (dx + x)) * 4;
      dst.data[di] = srcBuf[si];
      dst.data[di + 1] = srcBuf[si + 1];
      dst.data[di + 2] = srcBuf[si + 2];
      dst.data[di + 3] = 255;
    }
  }
};

blit(out, 0, src.data, src.width, src.height, src.channels);
for (let y = 0; y < h; y++) {
  for (let d = 0; d < DIVIDER; d++) {
    const di = (y * out.width + src.width + d) * 4;
    out.data[di] = 26; out.data[di + 1] = 217; out.data[di + 2] = 199; out.data[di + 3] = 255;
  }
}
blit(out, src.width + DIVIDER, oursRaw.data, oursRaw.width, oursRaw.height, 4);

fs.writeFileSync(OUT, PNG.sync.write(out));
console.log(`${OUT}  (${out.width}x${out.height}, source ${src.width}x${src.height} | ours ${oursRaw.width}x${oursRaw.height})`);
