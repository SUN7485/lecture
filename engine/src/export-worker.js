#!/usr/bin/env node
import * as fs from "node:fs";
import { exportWithDelivery } from "./delivery/export.js";
import { refontPptx } from "./pptx/refont.js";

const payloadFile = process.argv[2];
const send = (message) => process.send?.(message);

if (!payloadFile || !fs.existsSync(payloadFile)) {
  send({ type: "failed", error: "Export job payload is missing" });
  process.exit(2);
}

try {
  const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
  const result = await exportWithDelivery({
    model: payload.model,
    sourcePdf: payload.pdf,
    outPath: payload.file,
    mode: payload.delivery,
    overrides: payload.overrides,
    onStage: (update) => send({ type: "stage", update }),
  });

  // THIS BUTTON EXISTS TO PRODUCE A FILE FOR SOMEBODY ELSE, so it is the one
  // path that must not depend on the fonts installed on THIS machine. The CLI
  // keeps `--portable` opt-in because the benchmark and the release gauntlet
  // compare against baselines built the faithful way; nothing measures this
  // path, and the deck that went to a reader and came back reported as boxes
  // and CJK glyphs came out of here. See src/pptx/refont.js.
  send({ type: "stage", update: { stage: "portable", detail: "re-pointing fonts at faces that ship everywhere" } });
  const portable = await refontPptx(payload.file, payload.file);

  send({
    type: "done",
    result: {
      ...result.stats,
      fonts: result.fonts,
      coverage: result.coverage,
      delivery: result.delivery,
      // Reported, never silent: a typeface the reader did not ask us to change
      // is exactly the kind of correct-but-unexplained transform that gets filed
      // as the product's worst bug.
      portable: {
        rewritten: portable.rewritten,
        droppedFontParts: portable.droppedFontParts,
        uncovered: portable.uncovered,
        swaps: [...portable.swaps.entries()].map(([from, r]) => ({ from, to: r.to, slots: r.slots })),
      },
    },
  });
} catch (err) {
  send({ type: "failed", error: String(err?.message || err).slice(0, 500) });
  process.exitCode = 1;
} finally {
  fs.rmSync(payloadFile, { force: true });
}
