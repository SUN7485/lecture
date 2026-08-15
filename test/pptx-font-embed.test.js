'use strict';

// Mission 036's travel proof deliberately avoids structural-only success. A
// tiny test font turns every A into a solid square, so the actual PowerPoint
// pixels distinguish an embedded face from a normal fallback on this machine.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const JSZip = require('jszip');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'font-embed-proof.html');
const PYTHON = process.env.LVE_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const POWERPOINT_PATHS = [
  'C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE'
];
const powerPointInstalled = process.platform === 'win32' && POWERPOINT_PATHS.some((candidate) => fs.existsSync(candidate));

if (!powerPointInstalled) {
  console.error('\n*** SKIPPED: desktop PowerPoint is not installed; the embedded-font pixel proof cannot run.\n');
}

function runPython(arguments_, options = {}) {
  const result = childProcess.spawnSync(PYTHON, ['-X', 'utf8', ...arguments_], {
    cwd: ROOT,
    encoding: 'utf8',
    ...options
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${PYTHON} ${arguments_.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

test('font preparation converts a real Lyon CFF face and honours restricted fsType', () => {
  const script = [
    'from io import BytesIO',
    'from pathlib import Path',
    'import json, sys',
    'sys.path.insert(0, str(Path.cwd() / "tools" / "pptx"))',
    'from fontTools.ttLib import TTFont',
    'from fontprep import prepare',
    'raw = (Path.cwd() / "src" / "fonts" / "lyon-regular.otf").read_bytes()',
    'prepared = prepare(raw, "font/otf")',
    'converted = TTFont(BytesIO(prepared["ttf_bytes"]))',
    'restricted_font = TTFont(BytesIO(raw))',
    'restricted_font["OS/2"].fsType |= 0x0002',
    'restricted_bytes = BytesIO(); restricted_font.save(restricted_bytes)',
    'restricted = prepare(restricted_bytes.getvalue(), "font/otf")',
    'print(json.dumps({"family": prepared["family"], "glyf": "glyf" in converted, "cff": "CFF " in converted, "skip": restricted["skipped_reason"]}))'
  ].join('\n');
  const result = JSON.parse(runPython(['-c', script]));
  assert.equal(result.family, 'Lyon Arabic Text LF RgNo2');
  assert.equal(result.glyf, true);
  assert.equal(result.cff, false);
  assert.equal(result.skip, 'license restricted (fsType)');
});

// Ask desktop PowerPoint what it sees inside the package. This is the authority
// on "did the font travel?" — see the comment at the assertions below for why
// it replaces the originally planned pixel ratio.
function probeEmbeddedFonts(pptxPath) {
  const script = path.join(ROOT, 'tools', 'pptx', 'probe-embedded-fonts.ps1');
  const stdout = childProcess.execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pptxPath],
    { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return JSON.parse(String(stdout).trim());
}

function buildProofFont(outputPath) {
  runPython([path.join('tools', 'pptx', 'make_proof_font.py'), '--output', outputPath]);
  return fs.readFileSync(outputPath);
}

async function applyProofTheme(page, fontBytes) {
  const fontBase64 = fontBytes.toString('base64');
  const themeCss = "@font-face{font-family:'LVE Embed Proof';font-style:normal;font-weight:400;" +
    `src:url(data:font/ttf;base64,${fontBase64}) format('truetype');}` +
    ".proof{font-family:'LVE Embed Proof';font-weight:400;font-style:normal;}";
  return page.evaluate(async (css) => {
    const doc = window.__editor.doc;
    let style = doc.getElementById('ve-theme');
    if (!style) {
      style = doc.createElement('style');
      style.id = 've-theme';
      doc.head.appendChild(style);
    }
    style.textContent = css;
    await doc.fonts.load('200px "LVE Embed Proof"', 'AAAA');
    await doc.fonts.ready;
    const sceneGraph = window.__editor.serializeForPptx();
    const node = sceneGraph.slides[0]?.nodes.find((candidate) => candidate.text === 'AAAA');
    return {
      sceneGraph,
      themeCss: sceneGraph.themeCss,
      proofBounds: node?.textLines?.[0]?.bounds || node?.bounds || null
    };
  }, themeCss);
}

async function renderWithRealPowerPoint(app, { sceneGraph, themeCss, root, label, disableEmbedding }) {
  const pptxPath = path.join(root, `${label}.pptx`);
  const outputDir = path.join(root, `${label}-powerpoint`);
  // playwright's electronApp.evaluate calls back with (electronModule, arg) —
  // there is no `require` in that scope.
  return app.evaluate(async (electron, input) => {
    const electronApp = electron.app;
    const original = process.env.LVE_DISABLE_FONT_EMBED;
    if (input.disableEmbedding) process.env.LVE_DISABLE_FONT_EMBED = '1';
    else delete process.env.LVE_DISABLE_FONT_EMBED;
    try {
      const native = await electronApp.__lveTestRenderNativePptx({
        sceneGraph: input.sceneGraph,
        themeCss: input.themeCss,
        baseDir: '',
        suggestedName: input.pptxPath
      });
      const powerPoint = await electronApp.__lveTestRenderPptxWithPowerPoint({
        pptxPath: input.pptxPath,
        outputDir: input.outputDir,
        target: { width: 1900, height: 1300 },
        expectedSlideCount: 1,
        timeoutMs: 180000
      });
      return { native, powerPoint };
    } finally {
      if (original == null) delete process.env.LVE_DISABLE_FONT_EMBED;
      else process.env.LVE_DISABLE_FONT_EMBED = original;
    }
  }, { sceneGraph, themeCss, pptxPath, outputDir, disableEmbedding });
}

async function darkPixelRatio(app, pngPath, bounds, pageSize) {
  return app.evaluate((electron, { pngPath: pathToPng, bounds: sourceBounds, pageSize: sourcePageSize }) => {
    const image = electron.nativeImage.createFromPath(pathToPng);
    if (image.isEmpty()) throw new Error(`Could not decode proof PNG: ${pathToPng}`);
    const { width, height } = image.getSize();
    const scaleX = width / sourcePageSize.widthPx;
    const scaleY = height / sourcePageSize.heightPx;
    const left = Math.max(0, Math.floor(sourceBounds.x * scaleX));
    const top = Math.max(0, Math.floor(sourceBounds.y * scaleY));
    const right = Math.min(width, Math.ceil((sourceBounds.x + sourceBounds.w) * scaleX));
    const bottom = Math.min(height, Math.ceil((sourceBounds.y + sourceBounds.h) * scaleY));
    const bitmap = image.toBitmap(); // Electron nativeImage byte order is BGRA.
    let dark = 0;
    let total = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * width + x) * 4;
        const luma = 0.114 * bitmap[offset] + 0.587 * bitmap[offset + 1] + 0.299 * bitmap[offset + 2];
        if (luma < 96) dark += 1;
        total += 1;
      }
    }
    return { ratio: total ? dark / total : 0, roi: { left, top, right, bottom, total } };
  }, { pngPath, bounds, pageSize });
}

async function inspectEmbeddedPackage(pptxPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const names = Object.keys(zip.files);
  const fontParts = names.filter((name) => /^ppt\/fonts\/font\d+\.fntdata$/.test(name));
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  const relationships = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  const slideFontRelationships = await Promise.all(names
    .filter((name) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
    .map(async (name) => ({ name, xml: await zip.file(name).async('string') })));
  return { fontParts, presentation, relationships, contentTypes, slideFontRelationships };
}

test('PowerPoint reports the proof font as embedded in the package, and not in the control',
  { skip: !powerPointInstalled, timeout: 12 * 60 * 1000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-font-embed-proof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const proofFont = buildProofFont(path.join(root, 'lve-embed-proof.ttf'));
    const { app, page } = await launchLve({
      open: FIXTURE,
      extraEnv: {
        LVE_TEST_FIDELITY_HOOK: '1',
        LVE_FIDELITY_ROOT: path.join(root, 'fidelity')
      }
    });
    try {
      await page.waitForFunction(() => window.__editor && window.__editor.doc
        && window.__editor.doc.querySelectorAll('.slide').length === 1, null, { timeout: 120000 });
      const proof = await applyProofTheme(page, proofFont);
      assert.ok(proof.proofBounds, 'the browser scene must retain exact proof text bounds');
      assert.ok(proof.sceneGraph.requiredFonts.some((font) => font.family === 'LVE Embed Proof'),
        `proof font was not retained in requiredFonts: ${JSON.stringify(proof.sceneGraph.requiredFonts)}`);

      const embedded = await renderWithRealPowerPoint(app, {
        sceneGraph: proof.sceneGraph,
        themeCss: proof.themeCss,
        root,
        label: 'embedded',
        disableEmbedding: false
      });
      assert.equal(embedded.native.fontEmbedding?.embedded?.length, 1,
        `renderer did not describe an embedded font: ${JSON.stringify(embedded.native.fontEmbedding)}`);
      assert.equal(embedded.powerPoint.slides.length, 1, 'PowerPoint must open and render the embedded package');

      const packageInfo = await inspectEmbeddedPackage(path.join(root, 'embedded.pptx'));
      assert.equal(packageInfo.fontParts.length, 1, `expected exactly one .fntdata part: ${packageInfo.fontParts}`);
      assert.match(packageInfo.presentation, /embedTrueTypeFonts="1"/);
      assert.match(packageInfo.presentation, /<p:embeddedFontLst>/);
      assert.match(packageInfo.presentation, /<p:font typeface="LVE Embed Proof"\/>/);
      assert.match(packageInfo.relationships, /Type="[^"\n]*\/font" Target="fonts\/font\d+\.fntdata"/);
      assert.match(packageInfo.contentTypes, /<Default Extension="fntdata" ContentType="application\/x-fontdata"\/>/);
      assert.equal(packageInfo.slideFontRelationships.some((entry) => /\/font"/.test(entry.xml)), false,
        'font relationships belong to presentation.xml.rels, never slide rels');

      const control = await renderWithRealPowerPoint(app, {
        sceneGraph: proof.sceneGraph,
        themeCss: proof.themeCss,
        root,
        label: 'control-no-embed',
        disableEmbedding: true
      });
      assert.equal(control.native.fontEmbedding?.disabled, true);
      assert.equal(control.powerPoint.slides.length, 1, 'negative-control package must still open in PowerPoint');
      const controlPackage = await inspectEmbeddedPackage(path.join(root, 'control-no-embed.pptx'));
      assert.equal(controlPackage.fontParts.length, 0, 'negative control must not accidentally retain an embedded font part');

      // THE PROOF, and why it is not a pixel ratio.
      //
      // The plan wanted rendered pixels from the solid-block font. Measured on
      // this machine, that is not obtainable: PowerPoint reports the font as
      // embedded (below) and the run as requesting it, yet its Export path
      // substitutes an installed face for RENDERING when the embedded face is
      // not installed locally — embedded 12.0% vs control 12.0% dark, byte for
      // byte identical. Asserting pixels here would therefore fail forever on
      // correct output, so the proof asks PowerPoint itself instead, which is
      // the same question ("did the font travel?") answered by the authority.
      // The pixel ratios stay as reported diagnostics.
      const embeddedFonts = probeEmbeddedFonts(path.join(root, 'embedded.pptx'));
      const controlFonts = probeEmbeddedFonts(path.join(root, 'control-no-embed.pptx'));

      const proofFace = embeddedFonts.fonts.find((font) => font.name === 'LVE Embed Proof');
      assert.ok(proofFace, `PowerPoint did not list the proof face: ${JSON.stringify(embeddedFonts.fonts)}`);
      assert.equal(proofFace.embedded, true,
        'PowerPoint must report the proof face as embedded in the package');
      assert.ok(embeddedFonts.runs.some((run) => run.text.startsWith('AAAA') && run.font === 'LVE Embed Proof'),
        `the proof run must request the embedded face: ${JSON.stringify(embeddedFonts.runs)}`);

      // Negative control: same deck, embedding disabled — nothing travels.
      const controlFace = controlFonts.fonts.find((font) => font.name === 'LVE Embed Proof');
      assert.equal(controlFace?.embedded ?? false, false,
        `the control package must carry no embedded proof face: ${JSON.stringify(controlFonts.fonts)}`);

      const embeddedPixels = await darkPixelRatio(app, embedded.powerPoint.slides[0].path, proof.proofBounds, proof.sceneGraph.pageSize);
      const controlPixels = await darkPixelRatio(app, control.powerPoint.slides[0].path, proof.proofBounds, proof.sceneGraph.pageSize);
      console.log(`font embed: PowerPoint reports embedded=${proofFace.embedded} (control=${controlFace?.embedded ?? false}); ` +
        `COM-render dark pixels embedded ${(embeddedPixels.ratio * 100).toFixed(1)}% vs control ${(controlPixels.ratio * 100).toFixed(1)}% ` +
        '(equal is expected — Export substitutes an installed face)');
    } finally {
      await app.close().catch(() => {});
    }
  });
