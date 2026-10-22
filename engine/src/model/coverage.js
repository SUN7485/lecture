/**
 * Coverage ledger — the "nothing was silently dropped" guarantee.
 *
 * Counts describe SOURCE elements and their delivered disposition. Output
 * object counts are retained only as diagnostics: one raster image may preserve
 * several source elements, so it cannot be the accounting unit.
 */

const SOURCE_CLASSES = ["glyphs", "vectors", "images", "shades"];

function sourceElementCount(object) {
  const count = object.provenance?.sourceElementCount ?? 1;
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
}

function sourceElements(objects) {
  return objects.reduce((total, object) => total + sourceElementCount(object), 0);
}

function classLedger(source, native, rasterized, extra = {}) {
  return {
    source,
    native,
    rasterized,
    dropped: Math.max(0, source - native - rasterized),
    ...extra,
  };
}

/** Audit one page's model against what the extractor found. */
export function auditPage(page, raw) {
  const { glyphCount, vectorCount, imageCount, shadeCount, backgroundCount } = raw;
  // Background promotion preserves the source element natively, but the
  // promoted fill still belongs to its original class. Older fixtures provide
  // only `backgroundCount`; those backgrounds predate shade promotion and are
  // treated as vectors for compatibility.
  const backgroundVectors = raw.backgroundVectorCount ?? backgroundCount ?? 0;
  const backgroundShades = raw.backgroundShadeCount ?? 0;

  const textObjects = page.objects.filter((o) => o.type === "text");
  const shapeObjects = page.objects.filter((o) => o.type === "shape");
  const imageObjects = page.objects.filter((o) => o.type === "image");
  const shadeShapes = shapeObjects.filter((o) => o.provenance?.sourceType === "shade");
  const sourceShapes = shapeObjects.filter((o) => o.provenance?.sourceType !== "shade");
  const shadeImages = imageObjects.filter((o) => o.isShade || o.provenance?.sourceType === "shade");
  const vectorFallbacks = imageObjects.filter((o) => o.isVectorFallback);
  const sourceImages = imageObjects.filter((o) =>
    !o.isVectorFallback && !o.isShade && o.provenance?.sourceType !== "shade");

  const glyphsMapped = textObjects.reduce((n, o) => n + (o.provenance?.glyphCount ?? 0), 0);
  // These are explicitly declared extractor repairs, not silent delivery loss.
  // They remain visible as `repaired`, while occupying the native/accounted
  // bucket so all source glyph records still reconcile into exactly one bucket.
  const glyphsRepaired = textObjects.reduce((n, o) => n + (o.provenance?.droppedGlyphs ?? 0), 0);

  const unsupported = sourceShapes.filter((o) => o.reconstructionStrategy === "unsupported");
  const nativeVectorShapes = sourceShapes.filter((o) => o.reconstructionStrategy !== "unsupported");
  const nativeShadeShapes = shadeShapes.filter((o) => o.reconstructionStrategy !== "unsupported");
  const decodedVectorFallbacks = vectorFallbacks.filter((o) => o.ref);
  const decodedShadeImages = shadeImages.filter((o) => o.ref);
  const nativeSourceImages = sourceImages.filter(
    (o) => o.ref || o.reconstructionStrategy === "degenerate");

  const byClass = {
    glyphs: classLedger(glyphCount, glyphsMapped + glyphsRepaired, 0, {
      delivered: glyphsMapped,
      repaired: glyphsRepaired,
    }),
    vectors: classLedger(
      vectorCount,
      sourceElements(nativeVectorShapes) + backgroundVectors,
      sourceElements(decodedVectorFallbacks),
    ),
    images: classLedger(imageCount, sourceElements(nativeSourceImages), 0),
    shades: classLedger(
      shadeCount,
      sourceElements(nativeShadeShapes) + backgroundShades,
      sourceElements(decodedShadeImages),
    ),
  };

  const issues = [];
  if (glyphsRepaired) {
    issues.push({
      severity: "warn",
      rule: "glyph-repaired-away",
      message: `${glyphsRepaired} orphan tanween glyph(s) removed — painted at a line start with no letter to belong to`,
    });
  }
  if (byClass.glyphs.dropped) {
    issues.push({
      severity: "error",
      rule: "unmapped-glyphs",
      message: `${byClass.glyphs.dropped} of ${glyphCount} glyphs are not in any text object`,
    });
  }
  if (byClass.vectors.dropped) {
    issues.push({
      severity: "error",
      rule: "unmapped-vectors",
      message: `${byClass.vectors.dropped} of ${vectorCount} vectors produced no usable output`,
    });
  }

  const representedSourceImages = sourceElements(sourceImages);
  const missingImageObjects = Math.max(0, imageCount - representedSourceImages);
  if (missingImageObjects) {
    issues.push({
      severity: "error",
      rule: "unmapped-images",
      message: `${missingImageObjects} of ${imageCount} images produced no object`,
    });
  }

  // An object without pixels is not delivered. This applies equally to native
  // images and to raster fallbacks for vectors or shades.
  const undecoded = imageObjects.filter(
    (o) => !o.ref && o.reconstructionStrategy !== "degenerate");
  if (undecoded.length) {
    issues.push({
      severity: "error",
      rule: "image-not-decoded",
      message: `${undecoded.length} picture object(s) carry no pixels and would export as nothing`
        + (undecoded[0].decodeError ? ` — ${undecoded[0].decodeError}` : ""),
    });
  }

  const degenerate = sourceImages.filter((o) => o.reconstructionStrategy === "degenerate");
  if (degenerate.length) {
    issues.push({
      severity: "warn",
      rule: "image-zero-area",
      message: `${degenerate.length} image(s) are placed with no width or height and paint nothing`,
    });
  }
  const masks = sourceImages.filter((o) => o.isMask);
  if (masks.length) {
    issues.push({
      severity: "warn",
      rule: "image-mask-untinted",
      message: `${masks.length} stencil mask(s) ship as their own pixels, not tinted with the fill colour the source used`,
    });
  }
  for (const o of unsupported) {
    issues.push({
      severity: "warn",
      rule: "unsupported-shape",
      objectId: o.id,
      message: `${o.shapeType} has no native PowerPoint primitive`,
    });
  }
  if (byClass.shades.dropped) {
    issues.push({
      severity: "error",
      rule: "unmapped-shades",
      message: `${byClass.shades.dropped} of ${shadeCount} gradient fill(s) produced no usable output`,
    });
    issues.push({
      severity: "warn",
      rule: "gradient-not-reproduced",
      message: `${byClass.shades.dropped} of ${shadeCount} gradient fill(s) present in the source and not emitted`,
    });
  }
  if (byClass.shades.rasterized) {
    issues.push({
      severity: "warn",
      rule: "gradient-rasterized",
      message: `${byClass.shades.rasterized} gradient fill(s) preserve their pixels but are not editable PowerPoint gradients`,
    });
  }
  if (raw.shadeSkippedCount) {
    issues.push({
      severity: "warn",
      rule: "shade-callback-no-visible-ink",
      message: `${raw.shadeSkippedCount} shade callback(s) painted no pixels after source clips/masks or repeated a cached pattern tile`,
    });
  }
  if (byClass.vectors.rasterized) {
    issues.push({
      severity: "warn",
      rule: "vector-rasterized",
      message: `${byClass.vectors.rasterized} complex vector path(s) preserve their pixels but are not editable PowerPoint primitives`,
    });
  }

  const reconciliationFailures = SOURCE_CLASSES.filter((name) => {
    const item = byClass[name];
    return item.native + item.rasterized + item.dropped !== item.source;
  });
  if (reconciliationFailures.length) {
    issues.unshift({
      severity: "error",
      rule: "coverage-reconciliation",
      message: reconciliationFailures.map((name) => {
        const item = byClass[name];
        return `${name}: source ${item.source}, classified ${item.native + item.rasterized + item.dropped}`;
      }).join("; "),
    });
  }

  const elements = SOURCE_CLASSES.reduce((ledger, name) => {
    const item = byClass[name];
    ledger.source += item.source;
    ledger.native += item.native;
    ledger.rasterized += item.rasterized;
    ledger.dropped += item.dropped;
    return ledger;
  }, { source: 0, native: 0, rasterized: 0, dropped: 0, byClass, reconciled: reconciliationFailures.length === 0 });

  return {
    page: page.index,
    source: { glyphs: glyphCount, vectors: vectorCount, images: imageCount, shades: shadeCount },
    output: {
      text: textObjects.length,
      shapes: shapeObjects.length,
      images: imageObjects.length,
      tables: page.tables?.length ?? 0,
      background: backgroundCount,
    },
    elements,
    issues,
  };
}

/** Roll page audits into a document-level verdict. */
export function summarizeCoverage(audits) {
  const errors = audits.flatMap((a) => a.issues
    .filter((i) => i.severity === "error")
    .map((i) => ({ page: a.page, ...i })));
  const warns = audits.flatMap((a) => a.issues
    .filter((i) => i.severity === "warn")
    .map((i) => ({ page: a.page, ...i })));
  const byClass = Object.fromEntries(SOURCE_CLASSES.map((name) => [name, {
    source: 0,
    native: 0,
    rasterized: 0,
    dropped: 0,
  }]));

  for (const audit of audits) {
    for (const name of SOURCE_CLASSES) {
      const target = byClass[name];
      const item = audit.elements.byClass[name];
      target.source += item.source;
      target.native += item.native;
      target.rasterized += item.rasterized;
      target.dropped += item.dropped;
      if (name === "glyphs") {
        target.delivered = (target.delivered ?? 0) + item.delivered;
        target.repaired = (target.repaired ?? 0) + item.repaired;
      }
    }
  }

  const sourceElements = audits.reduce((n, a) => n + a.elements.source, 0);
  const nativeElements = audits.reduce((n, a) => n + a.elements.native, 0);
  const rasterizedElements = audits.reduce((n, a) => n + a.elements.rasterized, 0);
  const droppedElements = audits.reduce((n, a) => n + a.elements.dropped, 0);
  const reconciled = audits.every((a) => a.elements.reconciled);

  return {
    pages: audits.length,
    sourceElements,
    nativeElements,
    rasterizedElements,
    droppedElements,
    byClass,
    errors: errors.length,
    warnings: warns.length,
    reconciled,
    pass: droppedElements === 0 && reconciled,
    detail: [...errors, ...warns].slice(0, 20),
  };
}
