export const VENDOR_ORDER = Object.freeze(["aspose", "apryse", "foxit"]);

export const VENDOR_THRESHOLDS = Object.freeze({
  plateauTurns: 2,
  plateauMaxGain: 0.003,
  plateauDamageFloor: 250,
  smokeVisualGain: 0.03,
  smokeNativeTextRate: 0.95,
  smokeArabicLoss: 0.002,
  fullDamageReduction: 0.30,
  fullRuntimeMultiple: 2,
});

/** The research ceiling opens only after two measured low-gain turns. */
export function plateauStatus(reports, thresholds = VENDOR_THRESHOLDS) {
  const valid = reports.filter((r) => Number.isFinite(r?.visual) && Number.isFinite(r?.damageTotal));
  const needed = thresholds.plateauTurns + 1;
  if (valid.length < needed) {
    return { fired: false, reason: `need ${needed} sequential benchmark reports; have ${valid.length}`, turns: [] };
  }
  const tail = valid.slice(-needed);
  const turns = tail.slice(1).map((report, i) => ({
    gain: report.visual - tail[i].visual,
    damage: report.damageTotal,
    qualifies: report.visual - tail[i].visual < thresholds.plateauMaxGain &&
      report.damageTotal > thresholds.plateauDamageFloor,
  }));
  return {
    fired: turns.every((t) => t.qualifies),
    reason: turns.every((t) => t.qualifies)
      ? "two consecutive convergence turns plateaued while meaningful damage remains"
      : "the editable engine is still converging, or damage is below the research ceiling",
    turns,
  };
}

export function smokeVerdict(metrics, baseline, thresholds = VENDOR_THRESHOLDS) {
  const checks = {
    opensWithoutRepair: metrics.opened === true && metrics.repaired === false,
    visualGain: Number.isFinite(metrics.visual) && metrics.visual - baseline.visual >= thresholds.smokeVisualGain,
    nativeText: Number.isFinite(metrics.nativeTextRate) && metrics.nativeTextRate >= thresholds.smokeNativeTextRate,
    arabicAccuracy: Number.isFinite(metrics.arabicAccuracy) &&
      metrics.arabicAccuracy >= baseline.arabicAccuracy - thresholds.smokeArabicLoss,
    noDisguisedRaster: metrics.disguisedRasterSlides === 0,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function fullVerdict(metrics, baseline, thresholds = VENDOR_THRESHOLDS) {
  const checks = {
    damageReduction: Number.isFinite(metrics.damageTotal) &&
      metrics.damageTotal <= baseline.damageTotal * (1 - thresholds.fullDamageReduction),
    runtime: Number.isFinite(metrics.elapsedMs) &&
      metrics.elapsedMs <= baseline.elapsedMs * thresholds.fullRuntimeMultiple,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

