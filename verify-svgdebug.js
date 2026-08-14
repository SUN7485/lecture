// Debug-only: check why svgToPngDataUrl might hang — does an SVG data-URL
// <img> fire onload/onerror/naturalWidth in this Electron renderer?
const { _electron } = require('playwright-core');
const path = require('path');
(async () => {
  const app = await _electron.launch({
    executablePath: require('electron'), args: ['.'], cwd: 'D:\\lectuer',
    env: { ...process.env, LVE_OPEN: path.resolve('2.html') },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() =>
    window.__editor && window.__editor.doc.querySelectorAll('.slide svg').length >= 2,
    null, { timeout: 60000 });
  await win.waitForTimeout(1500);

  const out = await win.evaluate(async () => {
    const ed = window.__editor;
    const svg = ed.doc.querySelectorAll('.slide svg')[0];
    const html = svg.outerHTML;
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(html);
    const result = { len: html.length };
    const img = new Image();
    await new Promise((resolve) => {
      const t = setTimeout(() => { clearTimeout(t); result.state = 'TIMEOUT'; result.naturalWidth = img.naturalWidth; result.naturalHeight = img.naturalHeight; resolve(); }, 5000);
      img.onload = () => { clearTimeout(t); result.state = 'LOAD'; result.naturalWidth = img.naturalWidth; result.naturalHeight = img.naturalHeight; resolve(); };
      img.onerror = () => { clearTimeout(t); result.state = 'ERROR'; resolve(); };
      img.src = src;
    });
    if (result.state === 'LOAD') {
      try {
        const c = document.createElement('canvas');
        c.width = 830 * 2; c.height = 110 * 2;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        result.canvasDataUrl = c.toDataURL('image/png').slice(0, 30) + ' len=' + c.toDataURL('image/png').length;
      } catch (e) { result.canvasErr = String(e); }
    }
    return result;
  });
  console.log('SVGLOAD:', JSON.stringify(out));
  await app.close();
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exitCode = 1; });