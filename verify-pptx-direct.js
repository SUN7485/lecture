const { _electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const DECK = process.argv[2] || path.resolve('2.html');
const OUT = path.join(os.tmpdir(), `lve-direct-${Date.now()}.pptx`);

(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: 'D:\\lectuer',
    env: { ...process.env, LVE_OPEN: path.resolve(DECK), LVE_EXPORT_PATH: OUT },
  });
  const win = await app.firstWindow();
  const logs = [];
  const errors = [];
  win.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
    if (m.type() === 'log') logs.push(m.text());
  });
  win.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));

  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length > 0,
    null, { timeout: 60000 });
  await win.waitForTimeout(1500);

  const plan = await win.evaluate(() => window.__editor.serializeForPptx());
  const dump = path.join(os.tmpdir(), `lve-plan-${Date.now()}.json`);
  fs.writeFileSync(dump, JSON.stringify(plan));
  console.log('PLAN slides=', plan.slides.length);

  // Time the JS SVG bake directly.
  const t0 = Date.now();
  let baked;
  try {
    baked = await Promise.race([
      win.evaluate((p) => window.__bakery.bake(p), plan),
      new Promise((_, rej) => setTimeout(() => rej(new Error('BAKE timed out')), 30000)),
    ]);
  } catch (e) {
    baked = null;
    console.log('BAKE threw:', String(e));
  }
  console.log('BAKE elapsed ms=', Date.now() - t0);
  console.log('BAKE logs:', JSON.stringify(logs));

  // Count baked (img) vs raw (svg) figures in result.
  if (baked) {
    let imgFigs = 0, rawSvg = 0;
    for (const s of (baked.slides || [])) for (const it of (s.content || [])) {
      if ((it.type === 'figure' || it.type === 'html') && /<svg/i.test(it.html || '')) rawSvg++;
      else if ((it.type === 'figure' || it.type === 'html') && /<img/i.test(it.html || '')) imgFigs++;
    }
    console.log('BAKE result: imgFigs=', imgFigs, 'rawSvg=', rawSvg);
  }

  // Now full IPC export with the BAKED plan to confirm python handles png figures.
  const t1 = Date.now();
  let res;
  try {
    res = await Promise.race([
      win.evaluate((p) => window.api.exportPptx({
        slidePlan: p, enrich: null, themeCss: p.themeCss || '',
        suggestedName: '2.pptx', baseDir: 'D:\\lectuer'
      }), baked || plan),
      new Promise((_, rej) => setTimeout(() => rej(new Error('IPC timed out')), 120000)),
    ]);
  } catch (e) { res = { ok: false, error: String(e) }; }
  console.log('IPC(baked) elapsed ms=', Date.now() - t1, 'result=', JSON.stringify(res));
  console.log('OUT exists:', fs.existsSync(OUT), 'size=', fs.existsSync(OUT) ? fs.statSync(OUT).size : '-');
  console.log('CONSOLE-ERRORS:', JSON.stringify(errors));
  await app.close();

  if (fs.existsSync(OUT)) {
    console.log('OUT=', OUT);
    const py = spawn('py', ['-X', 'utf8', 'D:\\lectuer\\tools\\pptx\\_inspect_pptx.py', OUT], { stdio: 'inherit' });
    await new Promise((r) => py.on('close', r));
  }
})().catch((e) => { console.error('FAIL (crash):', e && e.stack || e); process.exitCode = 1; });
