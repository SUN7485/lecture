// End-to-end PPTX verification: open 2.html in the real Electron app, run the
// Preview and the Doctor -> Auto-Fix & Export flows, then (in inspect-pptx.py)
// open the produced .pptx and assert slides 7/8 carry real pictures.
const { _electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const DECK = process.argv[2] || path.resolve('2.html');
const OUT = path.join(os.tmpdir(), `lve-pptx-${Date.now()}.pptx`);

(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: 'D:\\lectuer',
    env: { ...process.env, LVE_OPEN: path.resolve(DECK), LVE_EXPORT_PATH: OUT },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));

  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length > 0,
    null, { timeout: 60000 });
  await win.waitForTimeout(2500);

  // 1) The serialized plan: slide 7 & 8 must carry SVG figure items, and the
  //    per-element font sizes + h1 size must be captured (Bug A & C contract).
  const planInfo = await win.evaluate(() => {
    const ed = window.__editor;
    const plan = ed.serializeForPptx();
    return plan.slides.map((s, i) => ({
      n: i + 1,
      h1Fs: s.h1Fs,
      bodyFs: (s.content || []).find((it) => it.type === 'paragraph')?.fs || null,
      svgFigures: (s.content || []).filter((it) => /<svg/i.test(it.html || '')).map((it) => ({ kind: it.kind, len: (it.html || '').length })),
    }));
  });
  console.log('PLAN:', JSON.stringify(planInfo, null, 1));

  // 2) Preview button -> preview modal opens with slide cards.
  await win.click('#btn-preview-pptx');
  await win.waitForFunction(() =>
    !document.getElementById('preview-modal').hidden &&
    document.querySelectorAll('#preview-slides .preview-slide').length > 0,
    null, { timeout: 30000 });
  const previewCards = await win.evaluate(() =>
    document.querySelectorAll('#preview-slides .preview-slide').length);
  console.log('PREVIEW cards:', previewCards);

  // Normal pointer input reaches the cards and close control; after closing,
  // the next normal toolbar click proves the overlay no longer intercepts it.
  await win.click('#preview-slides .preview-slide');
  await win.click('#btn-preview-close');
  await win.waitForFunction(() => document.getElementById('preview-modal').hidden, null, { timeout: 10000 });

  // 3) Export button -> doctor modal has SVG warnings.
  await win.click('#btn-export-pptx');
  await win.waitForFunction(() => !document.getElementById('doctor-modal').hidden, null, { timeout: 30000 });
  const docIssues = await win.evaluate(() =>
    Array.from(document.querySelectorAll('#doctor-results .doctor-issue')).map((el) =>
      el.querySelector('.doctor-text b')?.textContent || ''));
  console.log('DOCTOR issues:', JSON.stringify(docIssues, null, 1));

  // 4) Click 'Auto-Fix & Export' -> it rasterises the SVGs, then exports.
  await win.click('#btn-doctor-fix');
  await win.waitForFunction(() => /Exported PPTX/.test(document.body.innerText),
    null, { timeout: 120000 });
  const status = await win.evaluate(() => {
    const m = document.body.innerText.match(/(Exported PPTX[^\n]*|Export [^\n]*(failed|cancelled)[^\n]*)/);
    return m ? m[1] : '(no status)';
  });
  console.log('EXPORT:', status);

  // 5) The deck's live SVGs should now be <img> (auto-fixed), so a re-export is
  //    fully self-contained.
  const afterFix = await win.evaluate(() => {
    const ed = window.__editor;
    return {
      remainingSvgs: ed.doc.querySelectorAll('.slide svg').length,
      bakedImgs: ed.doc.querySelectorAll('.slide img[src^="data:image/png"]').length,
    };
  });
  console.log('AFTER-FIX svgs remaining:', afterFix.remainingSvgs, '| baked imgs:', afterFix.bakedImgs);

  console.log('CONSOLE-ERRORS:', JSON.stringify(errors));
  console.log('OUT:', OUT);
  await app.close();

  // Inspect the produced .pptx with the Python checker.
  if (fs.existsSync(OUT)) {
    const py = spawn('py', ['-X', 'utf8', 'D:\\\\lectuer\\\\tools\\\\pptx\\\\_inspect_pptx.py', OUT], { stdio: 'inherit' });
    await new Promise((r) => py.on('close', r));
  }
})().catch((e) => { console.error('FAIL (crash):', e && e.stack || e); process.exitCode = 1; });
