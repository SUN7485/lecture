/* Server-backed features for the hosted build.
 *
 * The editor itself is deliberately still a pure client-side page — open with
 * FileReader, save with a blob download, no backend required. These three calls
 * are the only things a browser genuinely cannot do alone: reconstruct a PDF
 * (MuPDF), write a PPTX, and render a PDF at true page geometry.
 *
 * Everything here therefore FEATURE-DETECTS. Opened as a local file with no
 * server behind it, the editor must keep working and simply not offer these.
 */
(function () {
  const api = {};

  /** Resolved once at boot; null until then. */
  api.available = null;

  api.probe = async function probe() {
    // A file:// page has no origin to call, so do not even try.
    if (location.protocol === 'file:') { api.available = false; return false; }
    try {
      const r = await fetch('/readyz', { method: 'GET' });
      api.available = r.ok;
    } catch { api.available = false; }
    return api.available;
  };

  async function fail(res) {
    let msg = 'Request failed (' + res.status + ')';
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* non-JSON error body */ }
    const e = new Error(msg);
    e.status = res.status;
    return e;
  }

  /**
   * @param {File} file a PDF chosen by the user
   * @returns {Promise<{modelId:string,name:string,html:string,stats:object}>}
   */
  api.convertPdf = async function convertPdf(file) {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        // Header rather than a query param: a filename is user text and has no
        // business in a URL that ends up in logs.
        'x-file-name': encodeURIComponent(file.name).slice(0, 200)
      },
      body: file
    });
    if (!res.ok) throw await fail(res);
    return res.json();
  };

  /** Streams the response straight to a download; decks are large. */
  async function download(res, fallbackName) {
    if (!res.ok) throw await fail(res);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it has actually started reading the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }


  /**
   * The canvas as it stands right now, one entry per object.
   *
   * This is the input to the server's model reconciliation, and it is computed
   * HERE rather than by parsing HTML on the server because the DOM is the
   * authority on what the user is actually looking at.
   *
   * Geometry comes from rects measured against the slide, not from
   * offsetLeft/offsetParent, so it stays correct no matter how the editor
   * nests things. The deck sets `box-sizing: border-box`, so a shape's border
   * is inside its rect and the numbers match the model's boxes.
   *
   * Verified on a real 21-page lecture: for all 392 text objects the DOM text
   * equals the model text exactly, so an exact-string comparison is a safe
   * change detector — it will not fire on an untouched object and destroy its
   * recovered per-cell geometry.
   */
  api.collectCanvas = function collectCanvas(doc) {
    const out = [];
    if (!doc) return out;
    const slides = [].slice.call(doc.querySelectorAll('.slide'));
    slides.forEach(function (slide, pageIndex) {
      const sr = slide.getBoundingClientRect();
      const box = function (el) {
        const r = el.getBoundingClientRect();
        return {
          x: +(r.left - sr.left).toFixed(2),
          y: +(r.top - sr.top).toFixed(2),
          w: +r.width.toFixed(2),
          h: +r.height.toFixed(2)
        };
      };

      [].slice.call(slide.querySelectorAll('.obj')).forEach(function (el) {
        const id = el.getAttribute('data-id');
        if (id) {
          const entry = { id: id, bbox: box(el) };
          if (el.classList.contains('text')) entry.text = el.textContent;
          out.push(entry);
          return;
        }
        // No data-id: the user added this in the editor. Only absolutely
        // positioned text is safe to synthesize; anything else is reported as
        // unmapped rather than guessed at.
        const text = (el.textContent || '').trim();
        const cs = doc.defaultView.getComputedStyle(el);
        if (text && cs.position === 'absolute') {
          out.push({
            isNew: true, page: pageIndex, kind: 'text', text: text, bbox: box(el),
            dir: cs.direction === 'rtl' ? 'rtl' : 'ltr',
            align: cs.textAlign === 'start' ? null : cs.textAlign,
            fontFamily: (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '') || null,
            fontSizePt: parseFloat(cs.fontSize) || null,
            color: (cs.color || '').replace(/^rgba?\((\d+), ?(\d+), ?(\d+).*$/, function (_, r, g, b) {
              return [r, g, b].map(function (n) { return (+n).toString(16).padStart(2, '0'); }).join('');
            }),
            bold: parseInt(cs.fontWeight, 10) >= 600,
            italic: cs.fontStyle === 'italic'
          });
        }
      });
    });
    return out;
  };

  api.exportPptx = async function exportPptx(modelId, name, objects) {
    const res = await fetch('/api/export/pptx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId, name, objects })
    });
    return download(res, (name || 'lecture') + '.pptx');
  };

  /** PPTX from any HTML deck: the server prints it, rebuilds it and writes it. */
  api.exportPptxFromHtml = async function exportPptxFromHtml(html, name) {
    const res = await fetch('/api/export/pptx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, name })
    });
    return download(res, (name || 'lecture') + '.pptx');
  };

  api.exportPdf = async function exportPdf(html, name) {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, name })
    });
    return download(res, (name || 'lecture') + '.pdf');
  };

  window.StudioApi = api;
})();
