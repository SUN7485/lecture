/*
 * present.js — Present mode: fullscreen presenter + speaker view.
 * Pure DOM, zero Electron APIs. Loaded verbatim by BOTH the Electron renderer
 * and the static web port — keep web/present.js byte-identical to src/present.js.
 * Presents a CLEAN SNAPSHOT (editor.getCleanHtml()), never the live editable
 * iframe, so presenting can never mutate the deck. Exposes
 * window.Presenter.start(editor).
 *
 * Keyboard: ArrowRight/Space/PageDown/click = next, ArrowLeft/PageUp = prev
 * (index-based, not direction-based — this stays predictable regardless of
 * the deck's RTL/LTR reading direction). Home/End = first/last. Esc = exit.
 * B = toggle black blank, W = toggle white blank; any key/click after a
 * blank first clears the blank before acting.
 */
(function () {
  'use strict';

  function start(editor) {
    if (!editor || !editor.doc) return null;

    // Snapshot: parse the clean HTML into a detached document so slides here
    // are never the same nodes as the live editable iframe.
    const cleanHtml = editor.getCleanHtml();
    const parser = new DOMParser();
    const snapDoc = parser.parseFromString(cleanHtml, 'text/html');
    // A detached document has no layout, so editor.slides()' own geometry
    // filter can't run on it — instead, ask the ORIGINAL (attached) editor
    // which top-level nodes count as slides, then map those indices onto
    // the equivalent position in the snapshot's body.
    const liveSlides = editor.slides();
    const liveTop = Array.from(editor.doc.body.children);
    const slideIndexesInBody = liveSlides.map(s => liveTop.indexOf(s));
    const snapTop = Array.from(snapDoc.body.children);
    const slides = slideIndexesInBody.map(idx => snapTop[idx]).filter(Boolean);
    if (!slides.length) return null;

    const notes = liveSlides.map(s => editor.getSpeakerNotes(s));
    // Measure the deck's REAL slide footprint from the live (laid-out) editor —
    // including borders (e.g. the brand accent bar) — so decks that aren't the
    // default 950x650 scale to fit without clipping. Fall back to the convention.
    const slideW = (liveSlides[0] && liveSlides[0].offsetWidth) || 950;
    const slideH = (liveSlides[0] && liveSlides[0].offsetHeight) || 650;

    let i = 0;
    let blank = null; // null | 'black' | 'white'
    const startTime = Date.now();

    // ---- main fullscreen overlay ----
    const overlay = document.createElement('div');
    overlay.id = 've-present';
    overlay.style.cssText =
      'position:fixed;inset:0;background:#000;z-index:2147483000;display:flex;' +
      'align-items:center;justify-content:center;overflow:hidden;';
    // pointer-events:none on both children so ANY click within the overlay
    // (including on the visibly-presented slide) reaches the overlay's own
    // click handler — a same-origin iframe's clicks never bubble to the
    // parent document, so without this "click to advance" would only work
    // on the letterboxed edges around the slide.
    const frame = document.createElement('iframe');
    frame.style.cssText = 'border:0;background:#fff;transform-origin:center center;pointer-events:none;';
    frame.width = slideW; frame.height = slideH;
    overlay.appendChild(frame);
    const blankLayer = document.createElement('div');
    blankLayer.style.cssText = 'position:absolute;inset:0;display:none;pointer-events:none;';
    overlay.appendChild(blankLayer);
    document.body.appendChild(overlay);

    // ---- speaker window ----
    let speakerWin = null;
    function openSpeakerWindow() {
      speakerWin = window.open('', 'lve-speaker', 'width=520,height=680');
      if (!speakerWin) return;
      const d = speakerWin.document;
      d.title = 'نافذة الملقّن'; d.documentElement.dir = 'rtl';
      d.body.style.cssText = 'margin:0;font:15px/1.7 \'IBM Plex Sans Arabic\',\'Segoe UI\',system-ui,sans-serif;background:#080d1e;color:#eef3ff;display:flex;flex-direction:column;height:100vh;';
      d.body.innerHTML =
        '<div id="sp-timer" style="padding:10px 16px;font-size:24px;font-weight:700;background:#0a1024;color:#2ee6c8;font-variant-numeric:tabular-nums;letter-spacing:.5px;border-bottom:1px solid #1d2a51;">00:00</div>' +
        '<div id="sp-notes" dir="auto" style="padding:16px 18px;flex:1;overflow:auto;white-space:pre-wrap;font-size:16px;line-height:1.9;"></div>' +
        '<div style="padding:8px 16px;background:#0a1024;font-size:11px;font-weight:700;letter-spacing:.6px;color:#9db0dc;border-top:1px solid #1d2a51;">التالية · NEXT</div>' +
        '<iframe id="sp-next" style="border:0;width:100%;height:220px;background:#fff;"></iframe>';
    }

    // Render only the CURRENT slide inside the iframe (keeps memory/DOM
    // small and lets each slide sit centered regardless of its position in
    // the original document flow).
    function buildSingleSlideDoc(slideEl) {
      const headHtml = snapDoc.head ? snapDoc.head.innerHTML : '';
      return '<!doctype html><html><head>' + headHtml + '</head><body style="margin:0;">' + slideEl.outerHTML + '</body></html>';
    }

    function render() {
      // Main slide (scaled to fit viewport, aspect preserved).
      const vw = window.innerWidth, vh = window.innerHeight;
      const scale = Math.min(vw / slideW, vh / slideH);
      frame.style.transform = 'scale(' + scale + ')';
      const doc = frame.contentDocument;
      doc.open(); doc.write(buildSingleSlideDoc(slides[i])); doc.close();

      blankLayer.style.display = blank ? 'block' : 'none';
      blankLayer.style.background = blank === 'black' ? '#000' : blank === 'white' ? '#fff' : '';

      if (speakerWin && !speakerWin.closed) {
        const d = speakerWin.document;
        const notesEl = d.getElementById('sp-notes');
        if (notesEl) notesEl.textContent = notes[i] || 'لا توجد ملاحظات';
        const nextFrame = d.getElementById('sp-next');
        if (nextFrame && slides[i + 1]) {
          const nd = nextFrame.contentDocument;
          nd.open(); nd.write(buildSingleSlideDoc(slides[i + 1])); nd.close();
          const scale2 = Math.min(nextFrame.clientWidth / slideW, 220 / slideH);
          nd.body.style.transformOrigin = 'top left';
          nd.body.style.transform = 'scale(' + scale2 + ')';
        } else if (nextFrame) {
          nextFrame.contentDocument.open(); nextFrame.contentDocument.write(''); nextFrame.contentDocument.close();
        }
      }
    }

    function go(next) {
      if (blank) { blank = null; render(); return; }
      const n = Math.max(0, Math.min(slides.length - 1, next));
      if (n === i) return;
      i = n;
      render();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); stop(); return; }
      if (e.key.toLowerCase() === 'b') { blank = blank === 'black' ? null : 'black'; render(); return; }
      if (e.key.toLowerCase() === 'w') { blank = blank === 'white' ? null : 'white'; render(); return; }
      if (blank) { blank = null; render(); return; }
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
    }
    function onClick() {
      if (blank) { blank = null; render(); } else go(i + 1);
    }
    function onFullscreenChange() {
      if (!document.fullscreenElement) stop();
    }

    let timerId = null;
    function tick() {
      if (!speakerWin || speakerWin.closed) return;
      const el = speakerWin.document.getElementById('sp-timer');
      if (!el) return;
      const s = Math.floor((Date.now() - startTime) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      el.textContent = mm + ':' + ss;
    }

    let stopped = false;
    function stop() {
      if (stopped) return;
      stopped = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.removeEventListener('click', onClick);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (timerId) clearInterval(timerId);
      if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
      overlay.remove();
      if (speakerWin && !speakerWin.closed) speakerWin.close();
    }

    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', onClick);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    openSpeakerWindow();
    timerId = setInterval(tick, 1000);
    render();

    // Fullscreen the container; browsers without the API still work via the
    // fixed full-viewport overlay above.
    if (overlay.requestFullscreen) {
      overlay.requestFullscreen().catch(() => {});
    }

    return { stop: stop, next: () => go(i + 1), prev: () => go(i - 1) };
  }

  window.Presenter = { start: start };
})();
