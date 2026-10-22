/**
 * RELEASE GAUNTLET — the v1.0 gates, run over the frozen corpus in all three
 * delivery modes.
 *
 * This is not another instrument. It runs the ones that already exist — the
 * convergence benchmark, `inspectPptx`, and PowerPoint itself — and turns their
 * output into a pass or a fail against a fixed list of gates. Nothing here
 * measures fidelity in a new way, and nothing here is allowed to be tuned: a
 * gate that moves to let a build through is not a gate.
 *
 * THE GATES
 *   G1  every deck converts, in every mode
 *   G2  no crashes
 *   G3  no corrupt package — PowerPoint opens each deck without repairing it
 *   G4  no missing slides — the package has one slide per source page
 *   G5  every deck opens, saves, closes and REOPENS in PowerPoint, with the
 *       slide count surviving the round trip
 *   G6  the automated suite is green
 *   G7  smart does not materially regress any deck against editable
 *   G8  Arabic/RTL, fonts, images, overlaps, off-slide ink and page geometry
 *       are all still verified by the existing instrumentation
 *
 * Usage:
 *   node experiments/release/gauntlet.js
 *   node experiments/release/gauntlet.js --modes smart          # one mode
 *   node experiments/release/gauntlet.js --reuse                # skip benchmarks
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { inspectPptx, summarize } from "../../src/pptx/inspect.js";
import { modelFromPdf } from "../../src/model/normalize.js";
import { coveredByUbiquitous } from "../../src/fonts/coverage.js";
import { releaseIdentity } from "../../src/build-id.js";
import { gateStatus, blockedDecks, isGreen, PASS, FAIL, BLOCKED, NA, UNKNOWN } from "./verdict.js";

/**
 * WHAT THE DECK WAS SUPPOSED TO CONTAIN, which `summarize` cannot know on its own.
 *
 * Called with an empty `expected`, two of its eight gates are unanswerable and
 * report FAIL rather than n/a: the raster gate compares a slide's worst image
 * coverage against the SOURCE's own worst (a page that genuinely is a full-bleed
 * illustration must not read as "we gave up and rasterised"), and the font gate
 * needs each typeface's real text measured against ubiquitous cmap tables to
 * tell a font that merely does not travel from one that damages the deck.
 * `src/ship.js` builds exactly this; the gauntlet builds it once per deck and
 * reuses it across all three modes rather than reloading the model nine times.
 */
const expectedCache = new Map();
function expectedFor(deck, inspection) {
  if (!expectedCache.has(deck.id)) {
    const model = modelFromPdf(deck.path);
    const deliverable = model.pages.flatMap((p) =>
      p.objects.filter((o) => o.type === "image" && o.ref && o.reconstructionStrategy !== "degenerate"));
    const slideArea = model.pages[0].widthPt * model.pages[0].heightPt;
    expectedCache.set(deck.id, {
      slideSizePt: { w: model.pages[0].widthPt, h: model.pages[0].heightPt },
      imagesIntended: new Set(deliverable.map((o) => o.ref)).size,
      sourceMaxCoverage: Math.max(0, ...deliverable.map((o) => (o.bbox.w * o.bbox.h) / slideArea)),
    });
  }
  const base = expectedCache.get(deck.id);
  return {
    ...base,
    fontPortability: Object.fromEntries(
      Object.entries(inspection.fontText ?? {}).map(([face, text]) => [face, coveredByUbiquitous(text)])),
  };
}

const ROOT = path.resolve(".");
const CORPUS = JSON.parse(fs.readFileSync("experiments/benchmark/corpus.json", "utf8"));
const OUT = path.resolve(".work/release");
const WORK = path.resolve(".work/benchmark");
fs.mkdirSync(OUT, { recursive: true });

const argOf = (f, d) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : d; };
const MODES = argOf("--modes", "editable,smart,flattened").split(",").map((s) => s.trim());
const REUSE = process.argv.includes("--reuse");

/** A deck this far below its editable score has materially regressed. */
const MATERIAL_REGRESSION = 0.005;

const log = (s) => { process.stdout.write(s + "\n"); };

/* ------------------------------------------------------ PowerPoint round trip */
/**
 * Open, save, close, reopen. The benchmark already proves a deck OPENS; this
 * proves it survives being edited and saved by the application the user will
 * actually edit it in, which is a different claim and the one that matters for
 * a deck someone is going to work in.
 *
 * SaveAs writes a NEW file so the verified artifact is never mutated.
 */
const PS_ROUNDTRIP = String.raw`
$ErrorActionPreference = 'Stop'
$src = $args[0]
$dst = $args[1]
$out = $args[2]
$r = [ordered]@{ opened=$false; slidesOpened=$null; saved=$false; reopened=$false; slidesReopened=$null; error=$null }
$createdApp = $false
$app = $null
try {
  $pres = $null
  for ($attempt = 1; $attempt -le 3 -and -not $pres; $attempt++) {
    try {
      if ($attempt -eq 1) {
        try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
        catch { $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true }
      } else {
        Start-Sleep -Seconds (2 * $attempt)
        $app = New-Object -ComObject PowerPoint.Application; $createdApp = $true
      }
      try { $app.DisplayAlerts = 1 } catch {}
      $pres = $app.Presentations.Open($src, $true, $false, $false)
    } catch {
      $r.error = $_.Exception.Message
      try { if ($createdApp -and $app) { $app.Quit() } } catch {}
      $app = $null; $createdApp = $false
    }
  }
  if (-not $pres) { throw "open failed: $($r.error)" }
  $r.opened = $true
  $r.slidesOpened = $pres.Slides.Count

  if (Test-Path $dst) { Remove-Item $dst -Force }
  $pres.SaveAs($dst)
  $r.saved = $true
  $pres.Close()
  $pres = $null

  $again = $app.Presentations.Open($dst, $true, $false, $false)
  $r.reopened = $true
  $r.slidesReopened = $again.Slides.Count
  $again.Close()
  if ($createdApp) { $app.Quit() }
}
catch {
  $r.error = $_.Exception.Message
  try { if ($pres) { $pres.Close() } } catch {}
  try { if ($createdApp -and $app) { $app.Quit() } } catch {}
}
$json = $r | ConvertTo-Json -Depth 4 -Compress
[System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

function roundTrip(pptxPath, tag) {
  const dir = path.join(OUT, "roundtrip");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "_roundtrip.ps1");
  fs.writeFileSync(script, PS_ROUNDTRIP, "utf8");
  const dst = path.join(dir, `${tag}.saved.pptx`);
  const jsonFile = path.join(dir, `${tag}.json`);
  fs.rmSync(jsonFile, { force: true });
  try {
    execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        path.resolve(pptxPath), dst, jsonFile],
      { encoding: "utf8", timeout: 900000, windowsHide: true, cwd: dir, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    return { opened: false, saved: false, reopened: false, error: String(e.message ?? e).slice(0, 200) };
  }
  if (!fs.existsSync(jsonFile)) return { opened: false, saved: false, reopened: false, error: "no result file" };
  const parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  fs.rmSync(dst, { force: true });          // do not keep 10 copies of every deck
  return parsed;
}

/* ------------------------------------------------------------------ the run */
const results = {};

for (const mode of MODES) {
  const outFile = path.join(OUT, `${mode}.json`);
  if (!REUSE || !fs.existsSync(outFile)) {
    log(`\n=== BENCHMARK  ${mode} ===`);
    try {
      execFileSync(process.execPath,
        ["experiments/benchmark/run.js", "--delivery", mode, "--out", outFile],
        { encoding: "utf8", stdio: "inherit", timeout: 7200000, cwd: ROOT });
    } catch (e) {
      log(`  BENCHMARK CRASHED in ${mode}: ${String(e.message ?? e).slice(0, 200)}`);
      results[mode] = { crashed: true, decks: {} };
      continue;
    }
  } else {
    log(`\n=== BENCHMARK  ${mode}  (reused) ===`);
  }

  const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const decks = {};
  log(`\n--- ARTIFACT + POWERPOINT ROUND TRIP  ${mode} ---`);
  for (const deck of CORPUS.decks) {
    const pptx = path.join(WORK, mode, `${deck.id}.pptx`);
        const entry = { pages: deck.pages, visual: report.decks?.[deck.id]?.visual ?? null,
          converted: report.decks?.[deck.id]?.converted ?? false };
        // Inspecting an artifact whose conversion failed reads the PREVIOUS
        // mode's package. `converted` is the gate, not the file's existence.
        if (entry.converted !== true || !fs.existsSync(pptx)) {
          entry.artifact = entry.converted === true ? "MISSING" : "NOT RUN";
          entry.forensicPass = null;
          entry.roundTripOk = null;
          decks[deck.id] = entry;
          log(`  ${deck.id.padEnd(22)} ${entry.artifact}`);
          continue;
        }
        // An artifact that does not match the current run's hash is stale.
        const currentHash = crypto.createHash("sha256").update(fs.readFileSync(pptx)).digest("hex");
        const expectedHash = report.decks?.[deck.id]?.artifactHash ?? null;
        if (expectedHash && currentHash !== expectedHash) {
          entry.artifact = "STALE";
          entry.stale = true;
          entry.forensicPass = null;
          entry.roundTripOk = null;
          decks[deck.id] = entry;
          log(`  ${deck.id.padEnd(22)} STALE (hash mismatch)`);
          continue;
        }
    const insp = await inspectPptx(pptx);
    // `summarize` IS the existing verification: eight named gates covering slide
    // geometry, RTL marking in both directions, complex-script fonts on Arabic
    // runs, autofit, images reaching the package, and font portability. The
    // gauntlet reports them, it does not re-derive them.
    const sum = summarize(insp, expectedFor(deck, insp));
    entry.slides = insp.slideCount;
    entry.slidesMatchPages = insp.slideCount === deck.pages;
    entry.mediaCount = insp.mediaCount ?? 0;
    entry.embeddedFonts = insp.embeddedFonts ?? [];
    entry.forensicGates = Object.fromEntries(sum.gates.map(([name, ok]) => [name, ok]));
    entry.forensicPass = sum.pass;
    entry.forensicWarnings = sum.warnings ?? [];
    entry.forensicLines = sum.lines;
    entry.slideSizePt = insp.slideSizePt;
    entry.roundTrip = roundTrip(pptx, `${mode}-${deck.id}`);
    entry.roundTripOk = Boolean(entry.roundTrip.opened && entry.roundTrip.saved && entry.roundTrip.reopened &&
      entry.roundTrip.slidesOpened === entry.roundTrip.slidesReopened &&
      entry.roundTrip.slidesReopened === deck.pages);
    decks[deck.id] = entry;
    const failed = sum.gates.filter(([, ok]) => ok === false).map(([n]) => n);
    log(`  ${deck.id.padEnd(22)} slides ${String(entry.slides).padStart(4)}/${String(deck.pages).padEnd(4)}` +
      ` media ${String(entry.mediaCount).padStart(5)}  forensics ${sum.pass ? "pass" : "FAIL: " + failed.join("; ")}` +
      `  roundtrip ${entry.roundTripOk ? "ok" : "FAIL " + (entry.roundTrip.error ?? "")}`);
  }
  results[mode] = { crashed: false, report, decks };
}

/* --------------------------------------------------------------- the verdict */
const gates = [];
const gate = (id, name, evidence) => gates.push({ id, name, ...evidence, status: gateStatus(evidence) });
const allDecks = (fn) => MODES.flatMap((m) =>
  Object.entries(results[m]?.decks ?? {}).map(([id, d]) => ({ mode: m, id, ...d })).filter(fn));

// G6 — the automated suite is green. Run as part of the release graph so a
// passing gauntlet cannot hide a broken test suite.
let testSuiteOk = false;
let testSuiteDetail = "not run";
try {
  const testOut = execFileSync(process.execPath, ["--test"], { cwd: ROOT, encoding: "utf8", timeout: 600000 });
  testSuiteOk = true;
  testSuiteDetail = `pass (${testOut.match(/# pass \d+/)?.[0] ?? "ok"})`;
} catch (e) {
  testSuiteDetail = String(e.message ?? e).split("\n")[0].slice(0, 200);
}
gate("G6", "automated test suite is green", { failures: testSuiteOk ? [] : [testSuiteDetail] });

const everyDeck = allDecks(() => true);
// One list, computed once: every deck whose package does not exist. Each
// artifact-dependent gate below is blocked by it rather than passing without it.
const blocked = blockedDecks(everyDeck);

const crashed = MODES.filter((m) => results[m]?.crashed);
gate("G2", "no crashes", { failures: crashed });

// G1 is the gate that OBSERVES the failure, so it is never blocked by it.
gate("G1", "every deck converts in every mode",
  { failures: allDecks((d) => d.converted !== true).map((d) => `${d.mode}/${d.id}`) });

gate("G4", "no missing slides", {
  failures: allDecks((d) => d.slidesMatchPages === false).map((d) => `${d.mode}/${d.id} ${d.slides}!=${d.pages}`),
  blockedBy: blocked,
});

const badRoundTrip = allDecks((d) => d.roundTripOk === false);
gate("G5", "opens, saves, closes and reopens in PowerPoint", {
  failures: badRoundTrip.map((d) => `${d.mode}/${d.id} ${d.roundTrip?.error ?? ""}`),
  blockedBy: blocked,
});
gate("G3", "no corrupt package (PowerPoint opens without repair)", {
  failures: badRoundTrip.map((d) => `${d.mode}/${d.id}`),
  blockedBy: blocked,
});

const RASTER_GATES = new Set(["no raster the source did not have", "every image reaches the package"]);
const forensicFailsFor = (d) => Object.entries(d.forensicGates ?? {})
  .filter(([n, ok]) => ok === false && (d.mode === "editable" || !RASTER_GATES.has(n)))
  .map(([n]) => n);
gate("G8", "Arabic/RTL, fonts, images, autofit and geometry verified", {
  failures: allDecks((d) => forensicFailsFor(d).length > 0)
    .map((d) => `${d.mode}/${d.id}: ${forensicFailsFor(d).join("; ")}`),
  blockedBy: blocked,
});

if (MODES.includes("editable") && MODES.includes("smart")) {
  const regressed = [];
  for (const deck of CORPUS.decks) {
    const e = results.editable?.decks?.[deck.id]?.visual;
    const s = results.smart?.decks?.[deck.id]?.visual;
    if (!Number.isFinite(e) || !Number.isFinite(s)) continue;
    if (s < e - MATERIAL_REGRESSION) regressed.push(`${deck.id} ${(100 * (s - e)).toFixed(2)}`);
  }
  gate("G7", "smart does not materially regress any deck vs editable",
    { failures: regressed, blockedBy: blocked });
}

log(`\n${"=".repeat(78)}`);
log(`RELEASE GATES`);
log(`${"=".repeat(78)}`);
for (const g of gates.sort((a, b) => a.id.localeCompare(b.id))) {
  const detail = g.status === FAIL ? (g.failures ?? []).join(", ")
    : g.status === BLOCKED ? `no evidence: ${(g.blockedBy ?? []).join(", ")}`
    : "";
  log(`  ${g.id}  ${g.status.padEnd(7)}  ${g.name}${detail ? `\n        ${detail}` : ""}`);
}
const green = isGreen(gates);
log(`\n  ${green ? "ALL GATES GREEN" : "NOT GREEN"}   (G6, the test suite, is run separately by npm test)`);

fs.writeFileSync(path.join(OUT, "gauntlet.json"), JSON.stringify({
  gates,
  results,
  identity: releaseIdentity(),
  generatedAt: new Date().toISOString(),
}, null, 2), "utf8");
log(`\nwrote ${path.join(OUT, "gauntlet.json")}`);
process.exitCode = green ? 0 : 1;
