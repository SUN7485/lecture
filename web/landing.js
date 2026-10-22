/* Landing page: the demo slide answers the visitor's first edit. External,
   not inline — the hosted CSP allows scripts from 'self' only. */
(function () {
  const note = document.getElementById('pen-note');
  const slide = document.querySelector('.desk .slide');
  if (!note || !slide) return;
  slide.addEventListener('input', function once() {
    note.textContent = 'تمامًا، هكذا يعمل المحرر';
    slide.removeEventListener('input', once);
  });
  // Enter would insert <div>s into a one-line demo; keep it a single block.
  slide.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
})();
