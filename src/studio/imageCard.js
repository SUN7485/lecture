/*
 * imageCard.js — Lecture Studio v3 Phase 4: the image lab.
 *
 * Because images COST MONEY, editing one is deliberate and explicit:
 *
 *   • PROMPT textarea — English description, no auto-call.
 *   • STYLE presets — 4 mutually-exclusive options (photo, illustration,
 *     isometric, infographic). Each gets its own prompt series.
 *   • PROMPT-ASSIST chips — toggle ENGLISH modifiers that get appended.
 *   • ASPECT ratio — select from common ratios or auto (from rect).
 *   • VARIANT buttons — exactly 1, 2, or 4 with the cost shown.
 *   • VARIANTS grid — thumbnails of results; click to pick (FREE).
 *
 * The lab mounts into the card's inline editor. It mutates p.spec in place
 * and calls ctx.generate(n) / ctx.pick(i) (panel delegates to pipeline).
 * See plan §D6.
 */
(function () {
  'use strict';

  const STYLES = [
    ['photo', 'صورة واقعية (بدون نصوص — آمن)'],
    ['illustration', 'رسم مسطّح'],
    ['isometric', 'أيزومترك'],
    ['infographic', 'إنفوجرافيك (نصوص عربية)']
  ];

  const CHIPS_MAP = {
    'لقطة أقرب': 'close-up shot',
    'بدون أشخاص': 'no people',
    'إضاءة أدفأ': 'warmer lighting',
    'ألوان هادئة': 'muted calming colors',
    'تبسيط': 'minimal, simple composition',
    'زاوية علوية': 'top-down angle'
  };

  const ASPECTS = ['', '16:9', '4:3', '1:1', '3:4', '21:9'];
  const ASPECT_LABELS = {
    '': 'تلقائي — من المكان',
    '16:9': '16:9',
    '4:3': '4:3',
    '1:1': '1:1',
    '3:4': '3:4',
    '21:9': '21:9'
  };

  function mount(container, p, ctx) {
    container.addEventListener('click', (e) => e.stopPropagation());
    paint();

    // Full repaint
    function paint() {
      container.innerHTML = '';
      container.appendChild(promptField());
      container.appendChild(styleSection());
      container.appendChild(chipsSection());
      container.appendChild(aspectField());
      container.appendChild(variantButtons());
      container.appendChild(variantsGrid());
    }

    // Prompt textarea
    function promptField() {
      const wrap = document.createElement('div');
      wrap.className = 'il-field';
      const lbl = document.createElement('label');
      lbl.className = 'il-seclbl';
      lbl.textContent = 'وصف الصورة (إنجليزي أدق للنموذج)';
      wrap.appendChild(lbl);
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.dir = 'auto';
      ta.value = (p.spec && p.spec.imagePrompt) || '';
      ta.placeholder = 'مثال: modern industrial machinery in a factory setting…';
      ta.addEventListener('change', () => {
        p.spec.imagePrompt = ta.value.trim();
        p.spec.modifiers = p.spec.modifiers || [];
      });
      wrap.appendChild(ta);
      return wrap;
    }

    // Style presets
    function styleSection() {
      const wrap = document.createElement('div');
      wrap.className = 'il-styles';
      const lbl = document.createElement('span');
      lbl.className = 'il-seclbl';
      lbl.textContent = 'النمط';
      wrap.appendChild(lbl);
      STYLES.forEach(([val, label]) => {
        const id = 'sty-' + p.targetId + '-' + val;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'sty-' + p.targetId;
        input.id = id;
        input.value = val;
        if ((p.spec.style || 'photo') === val) input.checked = true;
        const labelEl = document.createElement('label');
        labelEl.htmlFor = id;
        labelEl.textContent = label;
        input.addEventListener('change', () => {
          p.spec.style = val;
          if (val === 'infographic') {
            // Show warning on infographic
            const warn = container.querySelector('.il-warn');
            if (warn) warn.style.display = 'block';
          } else {
            const warn = container.querySelector('.il-warn');
            if (warn) warn.style.display = 'none';
          }
        });
        wrap.appendChild(input);
        wrap.appendChild(labelEl);
      });
      // Infographic warning
      const warn = document.createElement('div');
      warn.className = 'il-warn';
      warn.textContent = '⚠ قد تظهر النصوص العربية مشوّهة أحيانًا.';
      warn.style.display = (p.spec.style === 'infographic') ? 'block' : 'none';
      wrap.appendChild(warn);
      return wrap;
    }

    // Prompt-assist chips
    function chipsSection() {
      const wrap = document.createElement('div');
      wrap.className = 'il-chips';
      Object.entries(CHIPS_MAP).forEach(([arLabel, enFragment]) => {
        const chip = document.createElement('button');
        chip.className = 'il-chip' + ((p.spec.modifiers || []).includes(enFragment) ? ' on' : '');
        chip.textContent = arLabel;
        chip.title = enFragment;
        chip.addEventListener('click', () => {
          p.spec.modifiers = p.spec.modifiers || [];
          const idx = p.spec.modifiers.indexOf(enFragment);
          if (idx >= 0) p.spec.modifiers.splice(idx, 1);
          else p.spec.modifiers.push(enFragment);
          chip.classList.toggle('on');
        });
        wrap.appendChild(chip);
      });
      return wrap;
    }

    // Aspect ratio select
    function aspectField() {
      const wrap = document.createElement('div');
      wrap.className = 'il-field';
      const lbl = document.createElement('label');
      lbl.className = 'il-seclbl';
      lbl.textContent = 'نسبة الارتفاع/العرض';
      wrap.appendChild(lbl);
      const sel = document.createElement('select');
      sel.innerHTML = ASPECTS.map(v =>
        `<option value="${v}"${(p.spec.aspect || '') === v ? ' selected' : ''}>${ASPECT_LABELS[v] || v}</option>`
      ).join('');
      sel.addEventListener('change', () => {
        p.spec.aspect = sel.value || undefined;
      });
      wrap.appendChild(sel);
      return wrap;
    }

    // Variant buttons
    function variantButtons() {
      const capable = !!(window.EnrichPipeline && window.EnrichPipeline.caps && window.EnrichPipeline.caps.image);
      const disabled = !capable || p.generating;
      const wrap = document.createElement('div');
      wrap.className = 'il-genrow';

      const b1 = document.createElement('button');
      b1.className = 'sd-b';
      b1.textContent = '🪙 ولّد نسخة (استدعاء واحد)';
      b1.disabled = disabled;
      b1.addEventListener('click', () => ctx.generate(1));
      wrap.appendChild(b1);

      const b2 = document.createElement('button');
      b2.className = 'sd-b';
      b2.textContent = '🪙 نسختان (استدعاءان)';
      b2.disabled = disabled;
      b2.addEventListener('click', () => ctx.generate(2));
      wrap.appendChild(b2);

      const b4 = document.createElement('button');
      b4.className = 'sd-b';
      b4.textContent = '🪙 ٤ نسخ (٤ استدعاءات)';
      b4.disabled = disabled;
      b4.addEventListener('click', () => ctx.generate(4));
      wrap.appendChild(b4);

      if (!capable) {
        const hint = document.createElement('div');
        hint.className = 'il-seclbl';
        hint.style.color = '#b8860b';
        hint.textContent = '⚠ أضِف مفتاح Gemini من ⚙️ للتوليد';
        wrap.appendChild(hint);
      }
      return wrap;
    }

    // Variants grid
    function variantsGrid() {
      const wrap = document.createElement('div');
      wrap.className = 'il-variants';
      const variants = p.variants || [];
      if (!variants.length) return wrap;

      const lbl = document.createElement('div');
      lbl.className = 'il-seclbl';
      lbl.style.gridColumn = '1 / -1';
      lbl.textContent = 'اختر نسخة — الباقي محفوظ للتبديل لاحقًا';
      wrap.appendChild(lbl);

      variants.forEach((v, i) => {
        const thumb = document.createElement('div');
        thumb.className = 'il-var' + (p.chosenVariant === i ? ' on' : '');
        const img = document.createElement('img');
        img.src = v.dataUrl;
        img.alt = 'نسخة ' + (i + 1);
        img.addEventListener('click', () => ctx.pick(i));
        thumb.appendChild(img);
        wrap.appendChild(thumb);
      });
      return wrap;
    }
  }

  window.ImageLab = { mount };
})();