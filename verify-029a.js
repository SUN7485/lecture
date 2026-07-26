// Drives the real Electron app on the fenced fixture. Run: node verify-029a.js
const { _electron } = require('playwright-core');
const path = require('path');
(async () => {
  const fx = path.resolve('test-fixtures/fenced-quirks.html');
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: { ...process.env, LVE_OPEN: fx },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length >= 2,
    null, { timeout: 30000 });
  const r1 = await win.evaluate(() => ({
    mode: window.__editor.doc.compatMode,
    bodyStyles: window.__editor.doc.body.querySelectorAll('style').length,
    fenceVisible: (window.__editor.doc.body.textContent || '').indexOf('\x60\x60\x60') !== -1,
  }));
  await win.click('#btn-brand');
  await win.waitForFunction(() => window.__editor.activeThemeKit() === 'MiM', null, { timeout: 20000 });
  const r2 = await win.evaluate(() => ({
    kit: window.__editor.activeThemeKit(),
    gold: window.__editor.win.getComputedStyle(window.__editor.doc.documentElement).getPropertyValue('--gold').trim(),
  }));
  await win.click('#btn-brand');
  await win.waitForFunction(() => window.__editor.activeThemeKit() === null, null, { timeout: 10000 });
  const r3 = await win.evaluate(() => ({ kit: window.__editor.activeThemeKit() }));
  await app.close();
  console.log('guard        :', JSON.stringify(r1));
  console.log('after click 1:', JSON.stringify(r2));
  console.log('after click 2:', JSON.stringify(r3));
  const pass = r1.mode === 'CSS1Compat' && r1.bodyStyles === 0 && !r1.fenceVisible &&
    r2.kit === 'MiM' && /#BFA19F/i.test(r2.gold) && r3.kit === null;
  console.log(pass ? 'PASS 029a' : 'FAIL 029a');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('FAIL 029a (crash):', e.message); process.exitCode = 1; });
