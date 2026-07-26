// Verifies the stray-markup doctor rule + honest themeAudit in the real app.
// Run: node verify-029b.js   (fixtures come from mission 029a's writer)
const { _electron } = require('playwright-core');
const path = require('path');
(async () => {
  const fx = path.resolve('test-fixtures/style-in-body.html');
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: { ...process.env, LVE_OPEN: fx },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length >= 2,
    null, { timeout: 30000 });
  const r = await win.evaluate(async () => {
    const ed = window.__editor;
    const out = {};
    let stray = window.SlideDoctor.analyze(ed).filter((i) => i.ruleId === 'stray-markup');
    out.firesBefore = stray.length;
    out.bodyStylesBefore = ed.doc.body.querySelectorAll('style').length;
    // Deck CSS still wins from <body> → the probe kit must report --gold as LOST:
    ed.applyThemeKit({ name: 'probe', varsCss: ':root{--gold:#BFA19F;}' });
    let a = ed.themeAudit();
    out.lostBefore = a.lost || 'NO-LOST-FIELD';
    out.recoloredBefore = a.recolored;
    // Run the rule's fix, re-scan (convergence), re-apply, re-audit:
    for (const i of stray) await i.fix();
    out.bodyStylesAfter = ed.doc.body.querySelectorAll('style').length;
    out.firesAfter = window.SlideDoctor.analyze(ed).filter((i) => i.ruleId === 'stray-markup').length;
    ed.applyThemeKit({ name: 'probe', varsCss: ':root{--gold:#BFA19F;}' });
    a = ed.themeAudit();
    out.lostAfter = a.lost;
    out.recoloredAfter = a.recolored;
    out.goldAfter = ed.win.getComputedStyle(ed.doc.documentElement).getPropertyValue('--gold').trim();
    return out;
  });
  await app.close();
  console.log(JSON.stringify(r, null, 2));
  const pass = r.firesBefore >= 1 && r.bodyStylesBefore >= 1 &&
    Array.isArray(r.lostBefore) && r.lostBefore.indexOf('--gold') !== -1 &&
    Array.isArray(r.recoloredBefore) && r.recoloredBefore.length === 0 &&
    r.firesAfter === 0 && r.bodyStylesAfter === 0 &&
    Array.isArray(r.lostAfter) && r.lostAfter.length === 0 &&
    r.recoloredAfter.indexOf('--gold') !== -1 && /#BFA19F/i.test(r.goldAfter);
  console.log(pass ? 'PASS 029b' : 'FAIL 029b');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('FAIL 029b (crash):', e.message); process.exitCode = 1; });
