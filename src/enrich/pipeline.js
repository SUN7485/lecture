/*
 * pipeline.js — the gated enrichment pipeline (renderer side, UI-free).
 *
 *   SCAN     free, offline — find slots (placeholders, tables) in the deck
 *   SUGGEST  ONE batched GLM call — text-only proposals with full specs
 *   APPROVE  the user, per item — edit spec/prompt/caption first
 *   GENERATE only approved items — diagrams/charts/equations render LOCALLY
 *            (zero API cost); only photos hit Gemini
 *   INSERT   the user — lands as a numbered, captioned figure
 *
 * Because SUGGEST already returns complete diagram JSON / latex / image
 * prompts, a typical session costs exactly: 1 GLM call + one Gemini call per
 * approved photo. A live meter counts every call. Everything is cached in
 * <lecture>.enrich.json keyed by slot content, so re-opening never re-pays.
 *
 * Proposal states: suggested → approved → generating → ready → inserted
 *                  (or rejected / error at any point)
 */
(function () {
  'use strict';
  const api = window.api;
  const Charts = window.EnrichCharts;
  const Diagrams = window.EnrichDiagrams;

  const SOURCE_LABEL = { chart: 'رسم بياني', diagram: 'مخطط', image: 'صورة', equation: 'معادلة', quiz: 'اختبار قصير' };

  const P = {
    editor: null,
    lecturePath: null,
    proposals: [],
    meter: { glm: 0, img: 0 },
    caps: { text: false, image: false },
    suggested: false,          // has the one SUGGEST call run (or been restored)?
    reviewed: false,           // has whole-lecture review run (or been restored)?
    onUpdate: () => {},        // UI hook: (proposal|null) — null = full refresh
    _cache: null,
    _xn: 0,                    // counter for synthetic "extra" proposal ids

    // ---- lifecycle ----------------------------------------------------------
    async init(editor, lecturePath) {
      this.editor = editor;
      this.lecturePath = lecturePath || null;
      this.proposals = [];
      this.suggested = false;
      this.reviewed = false;
      this._xn = 0;
      this._cache = await this._readCache();
      try { this.caps = await api.aiStatus(); } catch (_) { this.caps = { text: false, image: false }; }
      this.scan();
      this._rehydrateExtras();   // restore whole-lecture suggestions from cache
      // If every open slot already has a cached suggestion, restore silently —
      // zero calls. Otherwise the UI shows the explicit "Suggest" button.
      const open = this.proposals.filter(p => p.kind === 'pending');
      if (open.length && open.every(p => this._cachedSuggestion(p))) {
        open.forEach(p => this._applySuggestion(p, this._cachedSuggestion(p)));
        this.suggested = true;
      } else if (!open.length) {
        this.suggested = true;
      }
      this._renderAllFree();   // charts + any cached diagram/equation specs → previews
      this.onUpdate(null);
    },

    // ---- SCAN (free) --------------------------------------------------------
    scan() {
      const targets = this.editor.enrichTargets();
      const kept = [];
      // Preserve review extras and point-of-work wand proposals: neither is an
      // enrichTarget, so a rescan would otherwise drop them.
      const extras = this.proposals.filter(p => p.isExtra || p.isWand);
      for (const t of targets) {
        if (t.done) continue;                       // already consumed in a previous session
        const existing = this.proposals.find(p => p.targetId === t.id);
        if (existing) { kept.push(existing); continue; }
        if (t.kind === 'table') {
          const data = Charts.extractTableData(t.el);
          if (!data) continue;
          const cp = this._make({
            targetId: t.id, slideIndex: t.slideIndex, kind: 'chart',
            state: 'suggested', applyMode: 'after',
            why: 'جدول يحوي أرقامًا قابلة للرسم — يتولد محليًا بدون أي استدعاء',
            caption: data.title || this._heading(t.slideEl) || 'رسم بياني',
            spec: { chart: data }
          });
          this._renderFree(cp);            // charts are free ⇒ preview instantly
          kept.push(cp);
        } else if (t.kind === 'placeholder') {
          kept.push(this._make({
            targetId: t.id, slideIndex: t.slideIndex, kind: 'pending',
            state: 'suggested', applyMode: 'replace',
            slotText: this._cleanSlot(t.text), hasImg: t.hasImg, rect: t.rect,
            caption: this._cleanSlot(t.text).slice(0, 80) || this._heading(t.slideEl)
          }));
        }
      }
      this.proposals = kept.concat(extras);
      return this.proposals;
    },

    // ---- SUGGEST (the one GLM call) -----------------------------------------
    needsSuggest() {
      return this.proposals.some(p => p.kind === 'pending');
    },

    async suggest() {
      const pend = this.proposals.filter(p => p.kind === 'pending');
      if (!pend.length) { this.suggested = true; this.onUpdate(null); return { ok: true, cached: true }; }
      if (!this.caps.text) return { ok: false, error: 'No text model key — add one in Settings ⚙️.' };

      const ctx = this.editor.themeContext();
      const digest = this.editor.slidesDigest();
      const items = pend.map((p, k) => {
        const d = digest[p.slideIndex] || {};
        return {
          id: k,
          slideTitle: d.h1 || '', slideSubtitle: d.h2 || '',
          slideText: (d.text || '').slice(0, 380),
          reservedSlotText: p.slotText || ''
        };
      });

      const system =
        'You are an art director for Arabic (RTL) ministry training lectures. For each reserved visual slot, ' +
        'decide the single best visual and return its COMPLETE specification. Types:\n' +
        '- "diagram": concepts, processes, structures, comparisons. You supply content only — layout software draws it.\n' +
        '- "image": a real-world photographic scene (equipment, places, atmosphere).\n' +
        '- "equation": the slot or slide centers on a formula/calculation.\n' +
        'Return STRICT JSON — an array, one object per input id, no prose, no markdown fences:\n' +
        '{"id":N,"type":"diagram|image|equation",\n' +
        ' "why":"<Arabic, ≤12 words: why this type helps students here>",\n' +
        ' "caption":"<Arabic figure caption, concise, no numbering>",\n' +
        ' "diagram":{"layout":"flow|steps|cycle|hierarchy|timeline|comparison|pyramid",' +
        '"title":"<Arabic>","nodes":[{"label":"<Arabic 2-4 words>","sub":"<Arabic ≤8 words, optional>"}],' +
        '"links":[[parentIdx,childIdx]...] (hierarchy only),"emphasis":<idx, optional>},\n' +
        ' "imagePrompt":"<English, concrete photorealistic scene, NO text/letters/numbers in the image>",\n' +
        ' "latex":"<LaTeX, equation only>"}\n' +
        'Include ONLY the sub-field matching the chosen type. 3-6 nodes for most layouts; ' +
        '2-3 for comparison (put column content in sub). Arabic must be natural and concise.';
      const user = 'Lecture palette: ' + ctx.palette.join(', ') + '\nSlots:\n' + JSON.stringify(items);

      const res = await api.aiChat({ system, user, temperature: 0.3, maxTokens: 8000, timeoutMs: 240000 });
      this.meter.glm++;
      if (!res.ok) { this.onUpdate(null); return { ok: false, error: res.error }; }
      const arr = this._json(res.text);
      if (!Array.isArray(arr)) { this.onUpdate(null); return { ok: false, error: 'Model returned unusable JSON — try again.' }; }

      for (const item of arr) {
        const p = pend[item.id];
        if (p) this._applySuggestion(p, item);
      }
      // Anything the model skipped defaults to an image proposal.
      pend.forEach(p => {
        if (p.kind === 'pending') this._applySuggestion(p, { type: 'image', imagePrompt: p.slotText });
      });
      pend.forEach(p => this._renderFree(p));   // diagrams/equations preview at once
      this.suggested = true;
      await this._writeCache();
      this.onUpdate(null);
      return { ok: true };
    },

    // ---- REVIEW (whole lecture — one GLM call) ------------------------------
    // Reads EVERY slide that has no planned visual and proposes OPTIONAL extras
    // where a visual genuinely helps. Each extra can be placed as a new slide
    // (safe) or appended inside the source slide. Still exactly one call.
    async reviewLecture(onProgress) {
      if (!this.caps.text) return { ok: false, error: 'No text model key — add one in Settings ⚙️.' };
      const digest = this.editor.slidesDigest();
      const taken = new Set(this.proposals.filter(p => p.state !== 'rejected').map(p => p.slideIndex));
      const slides = digest
        .filter(d => !taken.has(d.i) && (d.text || '').length > 40)
        .map(d => ({ slide: d.i, title: d.h1 || '', subtitle: d.h2 || '', text: (d.text || '').slice(0, 300) }));
      if (!slides.length) { this.reviewed = true; this.onUpdate(null); return { ok: true, extras: 0 }; }

      // Small batches so each call returns quickly. A failed batch is NOT dropped
      // silently — it goes into a visible failure ledger the user can retry. A
      // renderer-side abort flag stops the loop before the next batch (the
      // in-flight call finishes; no new calls are issued). No IPC abort here.
      const CHUNK = 4;
      const batches = [];
      for (let i = 0; i < slides.length; i += CHUNK) batches.push(slides.slice(i, i + CHUNK));
      this._reviewAbort = false;
      this.reviewFailures = [];
      const shared = { taken, slides };
      let n = 0, okBatches = 0, cancelled = false;
      for (let bi = 0; bi < batches.length; bi++) {
        if (this._reviewAbort) { cancelled = true; break; }
        onProgress && onProgress(bi, batches.length);
        const r = await this._reviewBatch(batches[bi]);
        if (!r.ok) {
          this.reviewFailures.push({ batch: batches[bi], label: this._rangeLabel(batches[bi]), error: r.error || '' });
          this.onUpdate(null);
          continue;
        }
        okBatches++;
        n += this._ingestReviewItems(r.arr, shared);
        this.onUpdate(null);              // progressive reveal after each batch
      }
      onProgress && onProgress(batches.length, batches.length);
      this.reviewed = true;
      await this._writeCache();
      this.onUpdate(null);
      if (!okBatches && !this.reviewFailures.length) return { ok: false, error: 'الخدمة مشغولة (503/timeout) — جرّب لاحقًا.' };
      return { ok: true, extras: n, batches: batches.length, okBatches, failures: this.reviewFailures.length, cancelled };
    },

    // Turn a batch's raw items into extra proposals. Shared by review + retry so
    // the anchor/renumber logic lives in ONE place. Returns how many were added.
    _ingestReviewItems(arr, shared) {
      const { taken, slides } = shared;
      let added = 0;
      for (const item of (arr || [])) {
        const si = item.slide;
        if (typeof si !== 'number' || taken.has(si) || !slides.some(s => s.slide === si)) continue;
        const p = this._make({
          targetId: 'vx' + (++this._xn), slideIndex: si, kind: 'pending', state: 'suggested',
          isExtra: true, applyMode: item.placement === 'append' ? 'append' : 'newslide'
        });
        this._applySuggestion(p, item);
        p.isExtra = true;
        this._renderFree(p);
        this.editor.markSourceSlide(this.editor.slides()[si], p.targetId);
        this.proposals.push(p);
        taken.add(si);
        added++;
      }
      return added;
    },

    // Human label for a failed batch range, 1-based (e.g. "الشرائح ٩–١٢").
    _rangeLabel(batch) {
      const nums = batch.map(s => s.slide + 1);
      const lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
      return lo === hi ? ('الشريحة ' + lo) : ('الشرائح ' + lo + '–' + hi);
    },

    // User pressed إيقاف — stop before the next batch. Simple flag, no IPC abort.
    cancelReview() { this._reviewAbort = true; },

    // Retry ONE previously-failed range. Rebuilds the taken-set from live
    // proposals so we never double-insert. Returns { ok, added } / { ok:false }.
    async retryFailedRange(index) {
      const entry = this.reviewFailures && this.reviewFailures[index];
      if (!entry) return { ok: false, error: 'no such range' };
      const digest = this.editor.slidesDigest();
      const taken = new Set(this.proposals.filter(p => p.state !== 'rejected').map(p => p.slideIndex));
      const slides = digest.map(d => ({ slide: d.i }));
      const r = await this._reviewBatch(entry.batch);
      if (!r.ok) { entry.error = r.error || entry.error; this.onUpdate(null); return { ok: false, error: r.error }; }
      const added = this._ingestReviewItems(r.arr, { taken, slides });
      this.reviewFailures.splice(index, 1);
      await this._writeCache();
      this.onUpdate(null);
      return { ok: true, added };
    },

    // One small review batch (≤4 slides). Light output; retry once on transient
    // failures. Diagram node lists are built later, per approved item.
    async _reviewBatch(batch) {
      const system =
        'You review a few slides from an Arabic (RTL) ministry training lecture and flag any that would ' +
        'genuinely benefit from an EXTRA visual (process, structure, hierarchy, comparison, timeline, key ' +
        'formula, quantitative relationship, or a quick comprehension-check quiz). Be selective — SKIP ' +
        'title/agenda/intro/summary/references slides and anything already clear. Return STRICT JSON array ' +
        '(may be empty), no prose, no fences. Each item is SMALL: ' +
        '{"slide":N,"type":"diagram|image|equation|quiz","placement":"newslide|append",' +
        '"why":"<Arabic ≤10 words>","caption":"<Arabic ≤10 words, omit/empty for quiz>",' +
        '"imagePrompt":"<English, NO text — only if image>","latex":"<LaTeX — only if equation>",' +
        '"question":"<Arabic — only if quiz>","options":["<Arabic>", "..."] (3-4 items, only if quiz),' +
        '"correctIndex":<0-based integer — only if quiz>,"explanation":"<Arabic ≤15 words — only if quiz>"}\n' +
        'No diagram node lists. Use "quiz" sparingly — at most ONE per review, only for a slide with a ' +
        'single clear testable fact. Prefer "newslide" for quiz and diagram. "slide" MUST be one of the given indices.';
      const user = 'Slides:\n' + batch.map(s => `${s.slide}: ${s.title} — ${s.subtitle} — ${s.text}`).join('\n');
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await api.aiChat({ system, user, temperature: 0.35, maxTokens: 1500, timeoutMs: 90000, fast: true });
        this.meter.glm++;
        if (res.ok) { const arr = this._json(res.text); return { ok: Array.isArray(arr), arr: arr || [] }; }
        if (attempt === 0 && /^(429|5\d\d|timed out)/.test(res.error || '')) { await this._sleep(2500); continue; }
        return { ok: false, error: res.error };
      }
      return { ok: false };
    },
    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    // ---- SPEAKER NOTES (on-demand, per-slide — deliberately NOT part of the
    // proposal/ghost system: notes are invisible metadata, never rendered into
    // the slide, so there is nothing to preview or insert as a figure) --------
    async suggestNotes(slideIndex) {
      if (!this.caps.text) return { ok: false, error: 'لا يوجد مفتاح للنموذج النصي — أضِفه من الإعدادات ⚙️.' };
      const d = this.editor.slidesDigest()[slideIndex] || {};
      const system =
        'You write concise Arabic speaker notes (2-4 short sentences) for ONE slide of a ministry ' +
        'training lecture — talking points and a concrete example for the presenter, not a repeat of ' +
        'the slide text. Return STRICT JSON, no prose, no fences: {"notes":"<Arabic>"}';
      const user = 'العنوان: ' + (d.h1 || '') + ' — ' + (d.h2 || '') + '\nنص الشريحة: ' + (d.text || '').slice(0, 400);
      const res = await api.aiChat({ system, user, temperature: 0.4, maxTokens: 600 });
      this.meter.glm++;
      if (!res.ok) { this.onUpdate(null); return { ok: false, error: res.error }; }
      const j = this._json(res.text);
      const notes = (j && j.notes) || '';
      if (!notes) { this.onUpdate(null); return { ok: false, error: 'لم يرجع النموذج ملاحظات صالحة.' }; }
      this.editor.setSpeakerNotes(this.editor.slides()[slideIndex], notes);
      this.onUpdate(null);
      return { ok: true, notes };
    },
    getNotes(slideIndex) {
      return this.editor.getSpeakerNotes(this.editor.slides()[slideIndex]);
    },

    // Test/debug hook: inject an extra proposal without an API call (used to
    // verify placement mechanics offline).
    _injectExtra(o) {
      const p = this._make(Object.assign({
        targetId: 'vx' + (++this._xn), kind: 'diagram', state: 'suggested', isExtra: true,
        applyMode: 'newslide'
      }, o));
      p.isExtra = true;
      this.editor.markSourceSlide(this.editor.slides()[p.slideIndex], p.targetId);
      this.proposals.push(p);
      return p;
    },

    // ---- WAND (point-of-work, offline) --------------------------------------
    // Create (or replace) a proposal from a ✨ action on a live element. The
    // element is stamped with a stable data-ve-id so Apply anchors the visual
    // right after it. Free kinds render immediately, so the Studio card shows a
    // finished preview and a ghost can drop into the slide with zero API calls.
    // Returns the proposal (targetId → Studio.focus).
    wandProposal({ el, kind, spec, caption, why, applyMode }) {
      if (!this.editor || !el) return null;
      const targetId = this.editor.ensureTargetId(el);
      const slideIndex = Math.max(0, this.editor.slideIndexOf(el));
      // Re-running the wand on the same element replaces its earlier proposal.
      this.proposals = this.proposals.filter(p => p.targetId !== targetId || p.onSlide);
      const p = this._make({
        targetId, slideIndex, kind, state: 'suggested',
        applyMode: applyMode || 'after', isWand: true,
        spec: spec || {}, caption: caption || '', why: why || ''
      });
      this._renderFree(p);            // chart/diagram/equation → instant preview
      this.proposals.push(p);
      this.onUpdate(null);
      return p;
    },

    // Move an extra between "new slide" and "inside the slide" placement — live
    // if it's already on a slide.
    setPlacement(p, mode) {
      if (!p.isExtra || p.applyMode === mode) return;
      const wasOn = p.onSlide;
      if (wasOn) this._removeInserted(p);
      p.applyMode = mode;
      if (wasOn && p.result) this.insert(p);
      else this.onUpdate(p);
    },

    _removeInserted(p) {
      if (p.applyMode === 'newslide') this.editor.removeGeneratedSlide(p.targetId);
      else this.editor.removeFigure(p.targetId);
      p.onSlide = false;
      // Point display back at the source slide (extras) so the pin reappears there.
      const src = p.isExtra && this.editor.sourceSlideByProp(p.targetId);
      if (src) p.slideIndex = this.editor.slides().indexOf(src);
    },

    _rehydrateExtras() {
      const list = (this._cache && this._cache.extras) || [];
      const nSlides = this.editor.slides().length;
      for (const e of list) {
        if (typeof e.slideIndex !== 'number' || e.slideIndex >= nSlides) continue;
        const onSlide = !!(this.editor.figureByProp(e.id) || this.editor.generatedSlideByProp(e.id));
        const p = this._make({
          targetId: e.id, slideIndex: e.slideIndex, kind: e.kind || 'diagram',
          applyMode: e.applyMode || 'newslide', isExtra: true
        });
        p.spec = e.spec || {}; p.why = e.why || ''; p.caption = e.caption || '';
        p.captionEdited = !!e.captionEdited; p.result = e.result || null; p.onSlide = onSlide;
        p.state = onSlide ? 'inserted' : (p.result ? 'ready' : 'suggested');
        this.proposals.push(p);
        const num = parseInt(String(e.id).replace(/^vx/, ''), 10);
        if (num > this._xn) this._xn = num;
      }
      if (list.length) this.reviewed = true;
    },

    _applySuggestion(p, s) {
      const type = ['diagram', 'image', 'equation', 'chart', 'quiz'].includes((s.type || '').toLowerCase())
        ? s.type.toLowerCase() : 'image';
      p.kind = type === 'chart' ? 'diagram' : type;   // placeholder "chart" w/o table → diagram
      p.why = s.why || p.why || '';
      p.caption = s.caption || p.caption || '';
      p.spec = p.spec || {};
      if (p.kind === 'diagram') {
        p.spec.diagram = s.diagram && Array.isArray(s.diagram.nodes) && s.diagram.nodes.length >= 2
          ? s.diagram
          : { layout: 'flow', title: p.caption, nodes: [] };
      } else if (p.kind === 'image') {
        p.spec.imagePrompt = s.imagePrompt || p.slotText || 'industrial training scene';
        p.spec.style = p.spec.style || 'photo';
      } else if (p.kind === 'equation') {
        p.spec.latex = s.latex || '';
      } else if (p.kind === 'quiz') {
        p.caption = '';   // quiz slides are NOT numbered figures — keep out of «شكل N»
        p.spec.quiz = {
          question: s.question || '',
          options: Array.isArray(s.options) ? s.options.slice(0, 6) : [],
          correctIndex: Number.isInteger(s.correctIndex) ? s.correctIndex : 0,
          explanation: s.explanation || ''
        };
      }
      if (p.state !== 'inserted') p.state = 'suggested';
      p.result = s.result || p.result || null;
      if (p.result) p.state = 'ready';
    },

    // ---- APPROVE / edit ------------------------------------------------------
    approve(p) { if (p.state === 'suggested' || p.state === 'error') { p.state = 'approved'; p.error = null; this.onUpdate(p); } },
    unapprove(p) { if (p.state === 'approved') { p.state = 'suggested'; this.onUpdate(p); } },
    reject(p) { p.state = 'rejected'; this.onUpdate(p); },
    restore(p) { if (p.state === 'rejected') { p.state = p.result ? 'ready' : 'suggested'; this.onUpdate(p); } },

    setKind(p, kind) {
      if (p.kind === kind) return;
      p.kind = kind;
      p.result = null;
      // Retyping an on-slide figure keeps it live until the new one replaces it;
      // land on 'approved' so the generate button is right there.
      p.state = p.onSlide ? 'approved' : 'suggested';
      p.error = null;
      p.spec = p.spec || {};
      if (kind === 'diagram' && !p.spec.diagram) p.spec.diagram = { layout: 'flow', title: p.caption, nodes: [] };
      if (kind === 'image' && !p.spec.imagePrompt) { p.spec.imagePrompt = p.slotText || p.caption; p.spec.style = 'photo'; }
      if (kind === 'equation' && !('latex' in p.spec)) p.spec.latex = '';
      if (kind === 'quiz' && !('quiz' in p.spec)) p.spec.quiz = { question: '', options: [], correctIndex: 0, explanation: '' };
      this.onUpdate(p);
    },

    // Any spec edit invalidates a stale result (must regenerate). Editing an
    // on-slide figure is allowed — it stays put until you regenerate.
    touch(p) {
      if (p.result) { p.result = null; if (p.state === 'ready' || p.state === 'inserted') p.state = 'approved'; }
      this.onUpdate(p);
    },

    // Live caption edit — updates the on-slide figure immediately when inserted.
    setCaption(p, caption) {
      p.caption = caption;
      p.captionEdited = true;
      if (p.onSlide) this.editor.setFigureCaption(p.targetId, caption);
      this.onUpdate(p);
    },

    // Pull an inserted figure back off the slide (revert the insert). For a
    // "new slide" extra this removes the whole generated slide.
    removeFromSlide(p) {
      this._removeInserted(p);
      p.state = p.result ? 'ready' : 'suggested';
      this.onUpdate(p);
    },

    // ---- GENERATE (gate: approved only) --------------------------------------
    async generate(p, note) {
      if (p.generating) return;
      if (p.state === 'suggested') p.state = 'approved';   // explicit click = consent
      const wasOnSlide = p.onSlide;                        // regenerating in place?
      p.generating = true; p.error = null; p.state = 'generating';
      this.onUpdate(p);
      try {
        if (p.kind === 'image') {
          if (!this.caps.image) throw new Error('لا يوجد مفتاح Gemini — أضفه من الإعدادات ⚙️');
          const prompt = this._imagePrompt(p, note);
          const r = await api.aiImage({ prompt, aspectRatio: this._aspect(p.rect) });
          this.meter.img++;
          if (!r.ok) throw new Error(r.error || 'فشل توليد الصورة');
          p.result = { type: 'img', html: `<img src="${r.dataUrl}" alt="">` };
        } else {
          // Free kinds render locally (zero cost). Diagrams need a node list
          // first: build one via a single GLM call only when it's missing or
          // when the user asked for a change.
          if (p.kind === 'diagram' && (note || !p.spec.diagram || !(p.spec.diagram.nodes || []).length)) {
            await this._reviseDiagram(p, note);
          }
          if (!this._renderFree(p)) {
            throw new Error(
              p.kind === 'diagram' ? 'مواصفة المخطط ناقصة — عدّل العقد ثم أعد التوليد'
                : p.kind === 'equation' ? 'أدخل المعادلة (LaTeX) أولًا'
                  : p.kind === 'quiz' ? 'أدخل سؤالًا وخيارين على الأقل'
                    : 'الجدول غير قابل للرسم');
          }
        }
        p.state = 'ready';
        // If this figure is already on a slide, swap it in place — so "try
        // again" / "make it a graph instead" update the slide with one click.
        if (wasOnSlide && this.editor.figureByProp(p.targetId)) {
          this.editor.replaceFigureContent(p.targetId, p.result.html, p.caption || '', p.kind);
          p.state = 'inserted';
        }
        await this._writeCache();
      } catch (e) {
        p.error = e.message || String(e);
        p.state = 'error';
      } finally {
        p.generating = false;
        this.onUpdate(p);
      }
    },

    // ---- IMAGE VARIANTS (paid — one meter tick per image, always explicit) ---
    // Generate n variants WITHOUT touching p.result. Each attempt is one real
    // call and bumps the meter by one. Variants live on p.variants so the user
    // can pick one now and swap to a cached "loser" later for free.
    async generateVariants(p, n) {
      if (p.generating) return { ok: false, error: 'busy' };
      if (!this.caps.image) return { ok: false, error: 'لا يوجد مفتاح Gemini — أضِفه من الإعدادات ⚙️' };
      n = Math.max(1, Math.min(4, n | 0));
      p.generating = true; p.error = null;
      const prevState = p.state; p.state = 'generating';
      this.onUpdate(p);
      p.variants = p.variants || [];
      let made = 0, lastErr = null;
      try {
        const prompt = this._imagePrompt(p);
        const aspect = this._aspect(p.rect, p.spec.aspect);
        for (let i = 0; i < n; i++) {
          const r = await api.aiImage({ prompt, aspectRatio: aspect });
          this.meter.img++;                         // every attempt is a real call
          if (r.ok) { p.variants.push({ dataUrl: r.dataUrl, prompt }); made++; }
          else lastErr = r.error || 'فشل توليد الصورة';
          this.onUpdate(p);
        }
      } finally {
        p.generating = false;
        p.state = made ? 'ready' : prevState;
        this.onUpdate(p);
      }
      await this._writeCache();
      return made ? { ok: true, made } : { ok: false, error: lastErr || 'تعذّر التوليد' };
    },

    // Pick variant i as the live image (FREE — no call). Swaps an on-slide
    // figure in place; otherwise just sets result so ghost/Apply use it.
    pickVariant(p, i) {
      const v = p.variants && p.variants[i];
      if (!v) return;
      p.result = { type: 'img', html: `<img src="${v.dataUrl}" alt="">` };
      p.chosenVariant = i;
      p.state = 'ready';
      if (p.onSlide && this.editor.figureByProp(p.targetId)) {
        this.editor.replaceFigureContent(p.targetId, p.result.html, p.caption || '', p.kind);
        p.state = 'inserted';
      }
      this.onUpdate(p);
    },

    async generateApproved(onProgress) {
      const queue = this.proposals.filter(p => p.state === 'approved');
      let done = 0;
      for (const p of queue) {
        onProgress && onProgress(done, queue.length, p);
        await this.generate(p);
        done++;
      }
      onProgress && onProgress(done, queue.length, null);
      return queue.length;
    },

    // Revise (or build) a diagram spec via GLM — used on first-generate when the
    // suggest pass returned no nodes, or when the user asks for changes.
    async _reviseDiagram(p, note) {
      if (!this.caps.text) throw new Error('لا يوجد مفتاح للنموذج النصي');
      const d = this.editor.slidesDigest()[p.slideIndex] || {};
      const system =
        'Return ONLY strict JSON for one diagram spec (no prose, no fences):\n' +
        '{"layout":"flow|steps|cycle|hierarchy|timeline|comparison|pyramid","title":"<Arabic>",' +
        '"nodes":[{"label":"<Arabic 2-4 words>","sub":"<Arabic ≤8 words, optional>"}],' +
        '"links":[[parent,child]...] (hierarchy only),"emphasis":<idx optional>}\n' +
        '3-6 nodes. Content only — software draws it.';
      const user =
        'Slide: ' + (d.h1 || '') + ' — ' + (d.h2 || '') + '\n' +
        'Slide text: ' + (d.text || '').slice(0, 350) + '\n' +
        'Slot description: ' + (p.slotText || p.caption || '') + '\n' +
        (p.spec.diagram && (p.spec.diagram.nodes || []).length
          ? 'Current spec: ' + JSON.stringify(p.spec.diagram) + '\n' : '') +
        (note ? 'User revision request (must follow): ' + note : 'Produce the best spec.');
      const res = await api.aiChat({ system, user, temperature: 0.4, maxTokens: 2000 });
      this.meter.glm++;
      if (!res.ok) throw new Error(res.error);
      const spec = this._json(res.text);
      if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length < 2) throw new Error('لم يرجع النموذج مواصفة صالحة');
      p.spec.diagram = spec;
      if (spec.title && !p.captionEdited) p.caption = p.caption || spec.title;
    },

    // ---- INSERT ---------------------------------------------------------------
    insert(p) {
      if (!p.result) return { ok: false, error: 'generate first' };
      // Already on the slide (figure or new-slide) → swap in place, never a dead end.
      if (this.editor.figureByProp(p.targetId)) {
        this.editor.replaceFigureContent(p.targetId, p.result.html, p.caption || '', p.kind);
        p.state = 'inserted'; p.onSlide = true; this.onUpdate(p);
        return { ok: true };
      }
      // Resolve the source slide by its stable anchor (extras) or index.
      const slideEl = (p.isExtra && this.editor.sourceSlideByProp(p.targetId))
        || this.editor.slides()[p.slideIndex]
        || (this.editor.targetById(p.targetId) && this.editor.targetById(p.targetId).closest('.slide'))
        || null;

      // Whole-lecture extra placed as its own new slide after the source slide.
      if (p.isExtra && p.applyMode === 'newslide') {
        this.editor.insertGeneratedAsNewSlide(p.result.html, slideEl,
          { caption: p.caption || '', kind: p.kind, propId: p.targetId });
        const newSlide = this.editor.generatedSlideByProp(p.targetId);
        if (newSlide) p.slideIndex = this.editor.slides().indexOf(newSlide);   // display only
        p.state = 'inserted'; p.onSlide = true;
        this.onUpdate(p);
        return { ok: true };
      }

      const el = this.editor.targetById(p.targetId);
      let target;
      if (p.applyMode === 'after' && el) {
        el.setAttribute('data-ve-done', '1');            // table stays; mark consumed
        target = { mode: 'after', el, slideEl, kind: p.kind, propId: p.targetId };
      } else if (el && !p.isExtra) {
        target = { mode: 'replace', el, slideEl, kind: p.kind, propId: p.targetId };
      } else if (slideEl) {
        // Extra "inside the slide", or a placeholder already consumed → append.
        target = { mode: 'append', slideEl, kind: p.kind, propId: p.targetId };
      } else {
        p.error = 'الموضع لم يعد موجودًا في المستند'; p.state = 'error'; this.onUpdate(p);
        return { ok: false };
      }
      this.editor.insertGenerated(p.result.html, target, { caption: p.caption || '' });
      if (slideEl) p.slideIndex = this.editor.slides().indexOf(slideEl);        // display only
      p.state = 'inserted'; p.onSlide = true;
      this.onUpdate(p);
      return { ok: true };
    },

    // ---- FREE render (suggest = render) ----------------------------------------
    // Render a FREE visual (chart / diagram / equation) locally into p.result —
    // no API call, no meter. Called the moment a suggestion arrives so cards show
    // a finished preview instead of a promise. Diagrams need a node list first
    // (from SUGGEST or a GLM revise); without one this is a no-op that returns
    // false. Best-effort: never throws.
    _renderFree(p) {
      try {
        const ctx = this.editor.themeContext();
        if (p.kind === 'chart') {
          const svg = Charts.buildBarChartSVG(p.spec.chart, {
            palette: ctx.palette, rtl: ctx.rtl, fontFamily: ctx.fontFamily,
            title: (p.spec.chart && p.spec.chart.title) || p.caption
          });
          if (!svg) return false;
          p.result = { type: 'svg', html: svg };
        } else if (p.kind === 'diagram') {
          const d = p.spec.diagram;
          if (!d || !(d.nodes || []).length) return false;
          const svg = Diagrams.render(d, { palette: ctx.palette, rtl: ctx.rtl, fontFamily: ctx.fontFamily });
          if (!svg) return false;
          p.result = { type: 'svg', html: svg };
        } else if (p.kind === 'equation') {
          if (!(p.spec.latex || '').trim()) return false;
          p.result = { type: 'svg', html: this._equationSvg(p.spec.latex) };
        } else if (p.kind === 'quiz') {
          const html = this._quizHtml(p.spec.quiz);
          if (!html) return false;
          p.result = { type: 'html', html };
        } else {
          return false;
        }
        if (p.state === 'suggested') p.state = 'ready';   // free ⇒ immediately applicable
        p.error = null;
        return true;
      } catch (_) { return false; }
    },

    // Render every free proposal that doesn't already carry a result (used after
    // scan / suggest / review / cache-restore so the panel opens with previews).
    _renderAllFree() {
      for (const p of this.proposals) {
        if (!p.result && p.kind !== 'image' && p.kind !== 'pending') this._renderFree(p);
      }
    },

    // ---- ghost preview (in the real editor DOM) --------------------------------
    // Where WOULD insert(p) place this? Read-only — mirrors insert()'s resolution
    // without mutating the document, so a ghost lands exactly where Apply will.
    _ghostTarget(p) {
      if (this.editor.figureByProp(p.targetId)) return null;   // already on the slide
      const slideEl = (p.isExtra && this.editor.sourceSlideByProp(p.targetId))
        || this.editor.slides()[p.slideIndex]
        || (this.editor.targetById(p.targetId) && this.editor.targetById(p.targetId).closest('.slide'))
        || null;
      if (p.isExtra && p.applyMode === 'newslide') {
        return { mode: 'newslide', afterSlideEl: slideEl, kind: p.kind, caption: p.caption || '' };
      }
      const el = this.editor.targetById(p.targetId);
      if (p.applyMode === 'after' && el) return { mode: 'after', el, slideEl, kind: p.kind, caption: p.caption || '' };
      if (el && !p.isExtra) return { mode: 'replace', el, slideEl, kind: p.kind, caption: p.caption || '' };
      if (slideEl) return { mode: 'append', slideEl, kind: p.kind, caption: p.caption || '' };
      return null;
    },

    // Preview proposal p as a live ghost in the slide. Returns the ghost element
    // (for scroll-into-view) or null. Only free/ready proposals have a result.
    previewGhost(p) {
      if (!p || !p.result || p.onSlide) { this.editor.clearGhost(); return null; }
      const t = this._ghostTarget(p);
      if (!t) { this.editor.clearGhost(); return null; }
      t.html = p.result.html;
      return this.editor.showGhost(t);
    },
    clearGhost() { this.editor.clearGhost(); },

    // Apply = commit the real insert (history + save). Discard = drop the ghost
    // and mark the proposal rejected. Both clear any live ghost first.
    apply(p) { this.editor.clearGhost(); return this.insert(p); },
    discard(p) { this.editor.clearGhost(); this.reject(p); },

    // Humanized session cost for the panel header.
    meterText() {
      const g = this.meter.glm, i = this.meter.img;
      if (!g && !i) return 'هذه الجلسة: مجاني بالكامل ✓';
      const parts = [];
      if (i) parts.push(i + (i === 1 ? ' صورة' : ' صور'));
      if (g) parts.push(g + (g === 1 ? ' استدعاء نص' : ' استدعاءات نص'));
      return 'هذه الجلسة: ' + parts.join(' + ');
    },

    // ---- helpers ---------------------------------------------------------------
    _make(o) {
      return Object.assign({
        state: 'suggested', kind: 'pending', why: '', caption: '',
        spec: {}, result: null, error: null, generating: false, captionEdited: false,
        onSlide: false, isExtra: false
      }, o);
    },
    _heading(slideEl) {
      const h = slideEl && slideEl.querySelector('h1, h2');
      return h ? h.textContent.trim().slice(0, 60) : '';
    },
    _cleanSlot(t) {
      return (t || '').replace(/^[\[\(]|[\]\)]$/g, '')
        .replace(/مساحة بصرية محجوزة\s*[:：]?/g, '')
        .replace(/placeholder\s*\d*/ig, '').trim();
    },
    _aspect(rect, override) {
      if (override) return override;
      if (!rect || !rect.w || !rect.h) return '16:9';
      const r = rect.w / rect.h;
      if (r > 2.2) return '21:9';
      if (r > 1.45) return '16:9';
      if (r > 1.15) return '4:3';
      if (r > 0.85) return '1:1';
      return '3:4';
    },
    _imagePrompt(p, note) {
      const base = (p.spec.imagePrompt || '').trim();
      const style = p.spec.style || 'photo';
      const STYLE = {
        photo: 'Professional editorial photography for an industrial-engineering training course: ' +
          'clean modern factory environments, natural lighting, muted cool tones, shallow depth of field, high detail.',
        illustration: 'Modern flat vector illustration, clean geometric shapes, bold simple forms, minimal detail, ' +
          'professional training-material style.',
        isometric: 'Isometric 3D technical illustration, clean, subtle soft shadows, professional infographic style.',
        infographic: 'Clean modern infographic illustration with clear iconography and simple shapes.'
      };
      const series = STYLE[style] || STYLE.photo;
      const mods = (p.spec.modifiers || []).join(', ');
      const noText = style === 'infographic'
        ? 'Labels, if any, must be large, minimal and in clear Modern Standard Arabic.'
        : 'Absolutely no text, no words, no letters, no numbers, no logos, no watermarks anywhere in the image.';
      return series + ' Scene: ' + base + (mods ? '. ' + mods : '') + (note ? ' Revision: ' + note : '') + ' ' + noText;
    },
    _equationSvg(latex) {
      const MJ = window.MathJax;
      if (!latex || !latex.trim()) throw new Error('أدخل المعادلة (LaTeX) أولًا');
      if (!MJ || !MJ.tex2svg) throw new Error('محرك المعادلات غير محمّل');
      const node = MJ.tex2svg(latex, { display: true });
      const svg = node && node.querySelector('svg');
      if (!svg) throw new Error('تعذر تحويل المعادلة');
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // MathJax sizes in ex units; convert to a generous fixed height for slides.
      const exH = parseFloat(svg.getAttribute('height')) || 3;
      svg.setAttribute('height', Math.min(140, Math.max(42, exH * 9)) + 'px');
      svg.removeAttribute('width');
      const cur = svg.getAttribute('style') || '';
      svg.setAttribute('style', cur + ';color:#1A1A1A');
      return svg.outerHTML;
    },

    // Deterministic quiz-slide renderer — every node is built via DOM APIs
    // (never string-concatenated from model text into innerHTML), so LLM
    // output can NEVER inject markup. Native <details>/<summary> gives
    // click-to-reveal with zero JS. Fully self-contained inline styles (same
    // convention as diagrams.js/charts.js) so it renders identically in-app
    // and in the exported/printed HTML.
    _quizHtml(spec) {
      const q = spec || {};
      const opts = Array.isArray(q.options) ? q.options.slice(0, 6) : [];
      if (!q.question || opts.length < 2) return null;
      const ctx = this.editor.themeContext();
      const pal = (ctx.palette && ctx.palette.length) ? ctx.palette : ['#413258', '#1AD9C7'];
      const primary = pal[0] || '#413258';
      const accent = pal[1] || '#1AD9C7';
      const font = (ctx.fontFamily || 'inherit').replace(/"/g, "'");
      const dir = ctx.rtl ? 'rtl' : 'ltr';
      const letters = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];
      const idx = (Number.isInteger(q.correctIndex) && q.correctIndex < opts.length) ? q.correctIndex : 0;
      const doc = this.editor.doc;

      const wrap = doc.createElement('div');
      wrap.setAttribute('dir', dir);
      wrap.setAttribute('style',
        'font-family:' + font + ';border:2px solid ' + accent + ';border-radius:12px;' +
        'padding:18px 22px;background:#fff;color:' + primary + ';');

      const qEl = doc.createElement('p');
      qEl.setAttribute('style', 'font-size:20px;font-weight:700;margin:0 0 12px;color:' + primary + ';');
      qEl.textContent = '❓ ' + q.question;
      wrap.appendChild(qEl);

      const ol = doc.createElement('ol');
      ol.setAttribute('style', 'list-style:none;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:6px;');
      opts.forEach((o, i) => {
        const li = doc.createElement('li');
        li.setAttribute('style', 'font-size:16px;padding:6px 10px;border-radius:8px;background:#f5f7fb;border:1px solid #e3e6ee;');
        li.textContent = (letters[i] || String(i + 1)) + '. ' + o;
        ol.appendChild(li);
      });
      wrap.appendChild(ol);

      const det = doc.createElement('details');
      det.setAttribute('style', 'border-top:1px dashed ' + accent + ';padding-top:10px;');
      const sum = doc.createElement('summary');
      sum.setAttribute('style', 'cursor:pointer;font-weight:600;color:' + accent + ';');
      sum.textContent = 'إظهار الإجابة';
      det.appendChild(sum);
      const ansP = doc.createElement('p');
      ansP.setAttribute('style', 'margin:10px 0 0;font-size:16px;');
      const strong = doc.createElement('strong');
      strong.textContent = 'الإجابة الصحيحة: ';
      ansP.appendChild(strong);
      ansP.appendChild(doc.createTextNode((letters[idx] || '') + '. ' + opts[idx]));
      det.appendChild(ansP);
      if (q.explanation) {
        const exp = doc.createElement('p');
        exp.setAttribute('style', 'margin:6px 0 0;font-size:14px;opacity:.75;');
        exp.textContent = q.explanation;
        det.appendChild(exp);
      }
      wrap.appendChild(det);
      return wrap.outerHTML;
    },

    _json(text) {
      if (!text) return null;
      const s = String(text).replace(/```(?:json)?/gi, '').trim();
      const tryParse = (str) => { try { return JSON.parse(str); } catch (_) { return undefined; } };
      const repair = (str) => str.replace(/,\s*([\]}])/g, '$1');   // strip trailing commas
      let v = tryParse(s); if (v !== undefined) return v;
      v = tryParse(repair(s)); if (v !== undefined) return v;
      for (const [a, b] of [['[', ']'], ['{', '}']]) {
        const i = s.indexOf(a), j = s.lastIndexOf(b);
        if (i >= 0 && j > i) {
          const slice = s.slice(i, j + 1);
          v = tryParse(slice); if (v !== undefined) return v;
          v = tryParse(repair(slice)); if (v !== undefined) return v;
        }
      }
      return null;
    },

    // ---- cache (per lecture, keyed by slot content) -----------------------------
    _key(p) {
      const basis = p.kind === 'chart' || p.applyMode === 'after'
        ? 'table'
        : (p.slotText || '');
      let h = 0;
      const str = basis + '|' + p.slideIndex;
      for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return p.targetId + ':' + (h >>> 0).toString(36);
    },
    async _readCache() {
      if (!this.lecturePath) return {};
      try { return (await api.enrichCacheRead({ lecturePath: this.lecturePath })) || {}; }
      catch (_) { return {}; }
    },
    _cachedSuggestion(p) {
      const c = this._cache && this._cache.v2 && this._cache.v2[this._key(p)];
      return c || null;
    },
    async _writeCache() {
      if (!this.lecturePath) return;
      const v2 = (this._cache && this._cache.v2) || {};
      for (const p of this.proposals) {
        if (p.isExtra || p.isWand || p.kind === 'pending' || p.state === 'rejected') continue;
        v2[this._key(p)] = {
          type: p.kind, why: p.why, caption: p.caption,
          diagram: p.spec.diagram, imagePrompt: p.spec.imagePrompt, latex: p.spec.latex,
          result: p.result || undefined
        };
      }
      // Whole-lecture extras live in their own list (no target element to key on).
      const extras = this.proposals
        .filter(p => p.isExtra && p.kind !== 'pending' && p.state !== 'rejected')
        .map(p => ({
          id: p.targetId, slideIndex: p.slideIndex, kind: p.kind, applyMode: p.applyMode,
          why: p.why, caption: p.caption, captionEdited: p.captionEdited, spec: p.spec,
          result: p.result || undefined, onSlide: !!p.onSlide
        }));
      this._cache = { v2, extras };
      try { await api.enrichCacheWrite({ lecturePath: this.lecturePath, data: this._cache }); } catch (_) {}
    },

    // ---- UI summary helpers -------------------------------------------------------
    counts() {
      const c = { suggested: 0, approved: 0, ready: 0, inserted: 0, rejected: 0, pending: 0 };
      for (const p of this.proposals) {
        if (p.kind === 'pending') c.pending++;
        else c[p.state] = (c[p.state] || 0) + 1;
      }
      return c;
    },
    kindLabel(k) { return SOURCE_LABEL[k] || k; }
  };

  window.EnrichPipeline = P;
})();
