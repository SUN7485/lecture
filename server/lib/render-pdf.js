import { chromium } from 'playwright-core';

/**
 * HTML deck -> PDF, the hosted replacement for Electron's printToPDF.
 *
 * Uses the SYSTEM chromium rather than Playwright's bundled build on purpose:
 * Oracle's always-free tier is ARM (Ampere A1), and Playwright does not ship a
 * supported arm64 Linux chromium, while Debian does. CHROMIUM_PATH lets the
 * image say where it is; on a dev box Playwright's own build is the fallback.
 *
 * One browser is kept alive for the process. Launching per request costs ~300ms
 * and a lot of memory churn; a crashed browser is detected and relaunched
 * rather than wedging every later request.
 */
/** CSS px per PDF point: 96dpi / 72dpi. */
const PX_PER_PT = 96 / 72;

let browserPromise = null;

async function launch() {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return chromium.launch({
    executablePath,
    args: [
      // Required in a container: Chromium's sandbox needs privileges the
      // container deliberately does not have. The page is our own generated
      // HTML with no remote origins, and the CONTAINER is the sandbox.
      '--no-sandbox',
      '--disable-dev-shm-usage', // /dev/shm is tiny in Docker; use /tmp instead
      '--disable-gpu',
      '--font-render-hinting=none'
    ]
  });
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launch();
  let browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = launch();
    browser = await browserPromise;
  }
  return browser;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try { (await browserPromise).close(); } catch { /* already gone */ }
  browserPromise = null;
}

/**
 * @param {string} html  a self-contained deck (images already data: URLs)
 * @returns {Promise<Buffer>}
 */
export async function renderPdf(html, { timeoutMs = 120_000 } = {}) {
  const browser = await getBrowser();
  // A fresh context per render: no cookies, storage or state can travel between
  // two users' documents.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    // Nothing in a reconstructed deck should ever reach the network — images are
    // data: URLs and fonts are local. Anything else is either an injection or a
    // privacy leak, so it is refused rather than fetched.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue();
      return route.abort();
    });

    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    await page.evaluate(() => document.fonts?.ready);

    // Each slide keeps its own source geometry, so the PDF page size is taken
    // from the deck rather than forced to A4 — the same rule the desktop export
    // follows. preferCSSPageSize makes the injected @page authoritative.
    const size = await page.evaluate(() => {
      const slide = document.querySelector('.slide');
      if (!slide) return null;
      const r = slide.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });

    if (size) {
      // The deck's CSS px ARE the source PDF's points (model-to-html.js lays
      // out from bbox point coords), but CSS px is 1/96in while a PDF point is
      // 1/72in. Declaring the page in px therefore yields a page exactly 75%
      // of the source's physical size — measured 535x366 against a 713x488
      // source. Declare the paper in POINTS for true size, and scale the
      // content by 96/72 so it fills it.
      await page.addStyleTag({
        content:
          `@page { size: ${size.w}pt ${size.h}pt; margin: 0 }
           /* zoom, not printToPDF's scale: scale() repaints without resizing
              the layout box, so everything past the original viewport is
              CLIPPED — measured 0.759 word recall against 0.990. zoom resizes
              the box itself, so the slide genuinely becomes W pt wide. */
           .slide { zoom: ${PX_PER_PT} }
           html,body { margin:0 !important; padding:0 !important; background:#fff !important }
           .slide { margin:0 !important; box-shadow:none !important; page-break-after: always; break-after: page }
           .slide:last-child { page-break-after: auto; break-after: auto }`
      });
    }

    return await page.pdf({
      printBackground: true,
      preferCSSPageSize: Boolean(size),
      ...(size ? {} : { format: 'A4' })
    });
  } finally {
    await context.close().catch(() => {});
  }
}
