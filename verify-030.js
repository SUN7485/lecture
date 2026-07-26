// Verifies the brand-compliance chain end to end in the REAL Electron app, on a
// REAL lecture: kit adopts the deck's own color variables (editor._adoptDeckVars)
// + doctor Rule 21 rewrites hardcoded colors it cannot otherwise reach.
//
// Run: node verify-030.js [path-to-deck.html]
//
// Measures brand compliance the only way that can't lie: COMPUTED colors of
// every element, before the kit, after the kit, after the doctor fix, and after
// the kit is switched back off (the reversibility proof).
const { _electron } = require('playwright-core');
const path = require('path');

const DECK = process.argv[2] || path.resolve('2.html');

(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    env: { ...process.env, LVE_OPEN: path.resolve(DECK) },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length >= 2,
    null, { timeout: 40000 });

  // Injected once, used at every stage: the computed-color census.
  await win.evaluate(() => {
    // The guide's own hex table, verbatim: Black, 666666, E6E6E6, 1A1A1A,
    // 413258, B3B3B3, 1AD9C7, BFA19F (+ white and the F4F4F6 page canvas).
    const PALETTE = ['#413258', '#1AD9C7', '#BFA19F', '#1A1A1A', '#F4F4F6', '#FFFFFF',
      '#666666', '#B3B3B3', '#E6E6E6', '#000000'];
    window.__hex = (s) => {
      const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/.exec(String(s || ''));
      if (!m) return null;
      if (m[4] !== undefined && parseFloat(m[4]) < 1) return null; // translucent: depth, not brand
      return '#' + [m[1], m[2], m[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase();
    };
    window.__census = () => {
      const ed = window.__editor, doc = ed.doc, win2 = ed.win;
      const out = { total: 0, onBrand: 0, off: {}, sample: [] };
      const els = doc.querySelectorAll('body *');
      let i = 0;
      for (const el of els) {
        if (el.closest('.ve-overlay, .ve-toolbar, .ve-guide, .ve-ghost, .ve-palette, .ve-wandmenu')) continue;
        const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
        const cs = win2.getComputedStyle(el);
        // `color` only counts where text actually renders — a wrapper div's
        // inherited color paints nothing and would drown the real signal.
        let hasText = false;
        for (const node of el.childNodes) if (node.nodeType === 3 && /\S/.test(node.nodeValue)) { hasText = true; break; }
        const props = isSvg ? ['fill', 'stroke'] : ['background-color'];
        if (hasText) props.push('color');
        for (const p of props) {
          const h = window.__hex(cs.getPropertyValue(p));
          if (!h) continue;
          out.total++;
          if (PALETTE.indexOf(h) !== -1) out.onBrand++;
          else out.off[h] = (out.off[h] || 0) + 1;
          if (i < 400) out.sample.push(h); // stable order -> comparable across stages
          i++;
        }
      }
      out.offTotal = out.total - out.onBrand;
      out.pct = out.total ? Math.round(100 * out.onBrand / out.total) : 0;
      out.worstOff = Object.entries(out.off).sort((a, b) => b[1] - a[1]).slice(0, 8);
      return out;
    };
  });

  const before = await win.evaluate(() => window.__census());

  // --- stage 1: click the MiM identity (kit + variable adoption) ---
  await win.click('#btn-brand');
  await win.waitForFunction(() => window.__editor.activeThemeKit() === 'MiM', null, { timeout: 30000 });
  const afterKit = await win.evaluate(() => {
    const a = window.__editor.themeAudit();
    return {
      census: window.__census(),
      audit: { fontPct: a.fontPct, recolored: a.recolored.length, lost: a.lost.length, missed: a.missed.length },
      adopted: (window.__editor.doc.getElementById('ve-theme').textContent.match(/:root\{/g) || []).length,
    };
  });

  // --- stage 2: the color rule ALONE, then switch the identity off. Only this
  // rule claims to be reversible, so it is tested alone: the other fixes (slide
  // splits, contrast, font embedding) are real content changes that must NOT
  // come back when the identity is toggled.
  const colorOnly = await win.evaluate(async () => {
    const ed = window.__editor;
    const hits = window.SlideDoctor.analyze(ed).filter(i => i.ruleId === 'hardcoded-colors');
    const counted = hits.length ? +hits[0].message.replace(/[^\d]/g, ' ').trim().split(/\s+/)[0] : 0;
    for (const i of hits) await i.fix();
    ed.commit();
    return {
      fired: hits.length, counted,
      firesAfter: window.SlideDoctor.analyze(ed).filter(i => i.ruleId === 'hardcoded-colors').length,
      census: window.__census(),
    };
  });
  await win.click('#btn-brand');
  await win.waitForFunction(() => window.__editor.activeThemeKit() === null, null, { timeout: 20000 });
  const reverted = await win.evaluate(() => window.__census());
  await win.click('#btn-brand');
  await win.waitForFunction(() => window.__editor.activeThemeKit() === 'MiM', null, { timeout: 30000 });

  // --- stage 3: «إصلاح الكل» exactly as the dock runs it (loop to convergence,
  // cap 5 passes) — the real user flow, and the honest test of EVO-009 now that
  // one rule's fix (low-contrast writes a literal color) feeds another's input.
  const doctor = await win.evaluate(async () => {
    const ed = window.__editor;
    const scan = () => window.SlideDoctor.analyze(ed);
    const hits = scan().filter(i => i.ruleId === 'hardcoded-colors');
    const counted = hits.length ? +hits[0].message.replace(/[^\d]/g, ' ').trim().split(/\s+/)[0] : 0;
    let passes = 0, fixed = 0;
    for (; passes < 5; passes++) {
      const fixable = scan().filter(i => i.fix);
      if (!fixable.length) break;
      for (const i of fixable) { try { await i.fix(); fixed++; } catch (_) {} }
      ed.commit();
    }
    const left = scan();
    return {
      firedBefore: hits.length, countedBefore: counted,
      passes, fixed,
      firesAfter: left.filter(i => i.ruleId === 'hardcoded-colors').length, // 0 -> converged
      fixableLeft: left.filter(i => i.fix).length,                         // 0 -> fix-all really fixed all
      census: window.__census(),
      allCards: window.SlideDoctor.aggregate(left).map(c => c.ruleId + '×' + c.count),
    };
  });

  // --- stage 4: does it all survive export? ---
  const exported = await win.evaluate(() => {
    const html = window.__editor.getCleanHtml();
    return {
      bytes: html.length,
      varRefs: (html.match(/var\(--[\w-]+(,\s*#[0-9A-Fa-f]{3,6})?\)/g) || []).length,
      keepsTheme: /id="ve-theme"/.test(html),
    };
  });

  await win.evaluate(() => window.scrollTo(0, 0));
  const shot = path.resolve('verify-030-' + path.basename(DECK, '.html') + '.png');
  await win.screenshot({ path: shot });
  await app.close();

  const line = (t, c) => `${t.padEnd(22)} on-brand ${String(c.pct).padStart(3)}%  (${c.onBrand}/${c.total})  off-brand instances: ${c.offTotal}`;
  console.log('deck:', DECK);
  console.log(line('BEFORE (as authored)', before));
  console.log('  worst off-brand:', JSON.stringify(before.worstOff));
  console.log(line('AFTER kit', afterKit.census), '| audit', JSON.stringify(afterKit.audit), '| :root blocks in kit', afterKit.adopted);
  console.log(line('AFTER color rule', colorOnly.census),
    `| fired ${colorOnly.fired} counting ${colorOnly.counted} literals, re-scan fires ${colorOnly.firesAfter}`);
  console.log(line('KIT OFF (revert)', reverted));
  console.log(line('AFTER fix-all', doctor.census));
  console.log('  rule: fired', doctor.firedBefore, 'counting', doctor.countedBefore,
    'literals | fix-all:', doctor.passes, 'passes,', doctor.fixed, 'fixes, re-scan fires',
    doctor.firesAfter, '| fixable left', doctor.fixableLeft);
  console.log('  worst remaining:', JSON.stringify(doctor.census.worstOff));
  console.log('  all doctor cards now:', doctor.allCards.join(', ') || '(none)');
  console.log('  export:', JSON.stringify(exported));
  console.log('  screenshot:', shot);

  const sameAsAuthored = JSON.stringify(reverted.sample) === JSON.stringify(before.sample);
  const pass =
    colorOnly.fired >= 1 &&                          // the rule sees the problem
    colorOnly.firesAfter === 0 &&                    // and stops seeing it -> fix-all converges
    colorOnly.census.pct > afterKit.census.pct &&    // the fix genuinely raised compliance
    afterKit.census.pct >= before.pct &&             // the kit never makes a deck LESS on-brand
                                                     // (an already-compliant deck has nothing to gain)
    sameAsAuthored &&                                // identity off == the deck exactly as authored
    doctor.census.pct >= 99 &&                       // fix-all lands on the brand
    doctor.fixableLeft === 0 &&                      // and leaves nothing fixable behind
    exported.keepsTheme && exported.varRefs > 0;     // and it all survives export
  console.log('revert identical to authored deck:', sameAsAuthored);
  console.log(pass ? 'PASS 030' : 'FAIL 030');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('FAIL 030 (crash):', e && e.stack || e); process.exitCode = 1; });
