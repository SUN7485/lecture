/**
 * GATE: a failed font embed must publish no deck.
 *
 * The embedder is deliberately replaced with a deterministic failure. The gate
 * passes only when delivery rejects with the requested face in the message and
 * removes both the final and sibling `.partial` package.
 *
 *   node experiments/verify-atomic-embed.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writePptx } from "../src/pptx/write.js";
import { deliverPptxAtomically } from "../src/pptx/embed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const finalPath = path.join(ROOT, ".work", "atomic-embed-gate.pptx");
const partialPath = finalPath.replace(/\.pptx$/i, ".partial.pptx");
const FACE = "Gate Test Arabic";

fs.mkdirSync(path.dirname(finalPath), { recursive: true });
fs.rmSync(finalPath, { force: true });
fs.rmSync(partialPath, { force: true });

const model = {
  document: { sourceFile: "atomic-embed-gate.pdf" },
  pages: [{
    widthPt: 720,
    heightPt: 405,
    background: "FFFFFF",
    objects: [{
      type: "text",
      text: "embedding must be atomic",
      sourceStreamDirection: "ltr",
      paragraphDirection: "ltr",
      alignment: "left",
      bbox: { x: 40, y: 40, w: 300, h: 30 },
      runs: [{
        text: "embedding must be atomic",
        fontFamily: FACE,
        fontSizePt: 20,
        color: "000000",
        script: "Latn",
      }],
    }],
  }],
};

let message = "";
try {
  await deliverPptxAtomically(
    finalPath,
    (file) => writePptx(model, file),
    {
      embedder: async (file) => {
        const bytes = fs.statSync(file).size;
        return { ok: false, reason: "seeded failure", embedded: [], skipped: [], bytesBefore: bytes, bytesAfter: bytes };
      },
    }
  );
} catch (err) {
  message = String(err?.message ?? err);
}

const finalExists = fs.existsSync(finalPath);
const partialExists = fs.existsSync(partialPath);
const passed = message.includes(FACE) && message.includes("0 of 1 fonts embedded") && !finalExists && !partialExists;

console.log(message || "NO ERROR THROWN");
console.log(`final exists: ${finalExists}`);
console.log(`partial exists: ${partialExists}`);
console.log(passed
  ? "GATE PASS: seeded embed failure was legible and published no deck."
  : "GATE FAIL: an embedding failure could ship a degraded or partial deck.");
process.exit(passed ? 0 : 1);
