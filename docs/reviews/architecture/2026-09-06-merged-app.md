# Architecture review: merged desktop and first hosted deployment

Date: 2026-09-06. Mode: DEEP. Baseline: HEAD bbfa1c5 plus the current tracked changes and untracked engine/, server/, deployment, and integration files. This is the first review; no accepted architecture review existed. Review only: no implementation changes.

## 1. Architecture verdict

**YELLOW** — significant architectural corrections are required; limit feature work touching document state, hosted processing, and storage lifetime until corrected.

## 2. Executive summary

The single application with a reusable reconstruction engine and separate desktop/hosted adapters is appropriate. The hosted adapter avoids exposing the local studio's filesystem APIs and centralizes session ownership. However, the merged editor has competing document representations: editing changes HTML while hosted PPTX exports the original model. Its import flow also retains a previous document's writable handle. Hosted execution and extracted-image storage lack complete lifecycle bounds. These are concrete ownership defects worth fixing before more editing features or public traffic build on them.

## 3. Preserve and change

**KEEP**
- Separate public HTTP surface from the trusted local studio; small explicit route table.
- Shared deterministic reconstruction engine with an ESM/CommonJS boundary rather than a rewrite.
- Central model-owner checks, random handles, and per-render browser contexts.
- Portable-font pass for hosted PPTX; explicit distinction from desktop PowerPoint verification.

**CHANGE NOW**
- Establish a single document/session owner for model revision, HTML revision, source type, save destination, and export eligibility.
- Isolate expensive parsing with enforceable deadlines; globally bound conversion and export work.
- Tie extracted image lifetime and storage quota to active model lifetime.

**CHANGE LATER**
- Refresh stale architecture/known-issue entries: package.json already moves pptxgenjs into runtime dependencies.
- Add cross-surface workflow tests covering edits, document switches, saves, and export contents, rather than only successful initial conversions.

**DO NOT CHANGE**
- Do not introduce microservices, distributed queues, or Redis for a single-instance deployment merely for architectural form.
- Do not weaken fidelity thresholds or replace the normalized reconstruction model just to make the merge simpler.

## 4. Findings

### A1. Edited deck and hosted PPTX have different authoritative state

- **Severity: HIGH. Evidence: CONFIRMED.**
- Evidence: web/app.js:1439-1441 saves an immutable server model handle and loads editable HTML. web/app.js:148-152 handles editing without updating the server model. web/app.js:1457 and web/api.js:76-82 submit only the model handle/name. server/app.js:217-225 retrieves and writes the original model. currentModelId has no reset on ordinary HTML/Word/recents document loads (web/app.js:144-171).
- Violated invariant: an exported deck must represent the active document and its accepted edits.
- Consequence: changing text, removing a slide, or applying a theme can appear successful while PPTX silently contains the pre-edit PDF reconstruction. Opening another HTML document can still export the previous PDF under the new name. Source tracing confirms this; a full edited-browser PPTX comparison was not run.
- If postponed: additional editor features deepen the lossy HTML/model divide and increase the cost of introducing reliable model revisions later. MERGE.md already identifies this unresolved architectural choice for desktop; the hosted path exposes its opposite failure.
- Direction: own document identity and revision explicitly. Either round-trip supported edits into the normalized model, or derive export from the active edited representation with explicit fidelity rules. Until that exists, make original-PDF conversion a distinct operation and invalidate its handle on document replacement; do not advertise edited PPTX export.
- Timing: **now**, before shipping the combined hosted edit/export workflow.

### A2. PDF import inherits the previous document's writable file handle

- **Severity: HIGH. Evidence: CONFIRMED.**
- Evidence: web/app.js:1438-1441 replaces the document without clearing fileHandle. The prior HTML picker persists that handle at web/app.js:570-572. saveHtml at web/app.js:534-541 only asks for a destination when no handle exists, then writes the active editor contents to the existing handle.
- Reproduction: evaluated the exact importPdfFile and saveHtml function bodies in an isolated Node VM with a mocked previously authorized original.html handle; imported PDF-A, then Save. Recorded result: destination original.html, written contents `<html>imported PDF content</html>`. No user files were written.
- Violated invariant: replacing the active document must invalidate the prior document's save authority unless explicitly retaining that document.
- Consequence: normal HTML-open → PDF-import → Save can overwrite an unrelated original HTML file.
- If postponed: every new import and recovery path must manually coordinate more global variables, increasing data-loss risk.
- Direction: centralize document replacement so it atomically resets or supplies the model handle, filesystem handle, dirty/recovery state and name. Validate save targets against the active document identity.
- Timing: **now**, before release.

### A3. Hosted expensive work is neither fully bounded nor interruptible

- **Severity: HIGH. Evidence: CONFIRMED** for missing controls; actual hostile-input outage magnitude is **not measured**.
- Evidence: server/app.js:190-198 runs synchronous modelFromPdf directly on the HTTP event loop. engine/src/model/normalize.js:236-250 processes every page. conversionTimeoutMs is defined at server/config.js:32 but never consumed. PDF/PPTX routes at server/app.js:215-244 bypass convertGate entirely. render-pdf.js creates a fresh context per call; no global export gate limits concurrent browser contexts. The requestTimeout assignment at app.js:269 does not terminate synchronous reconstruction work.
- Violated invariant: one document must not monopolize or exhaust the shared service, and declared processing deadlines must be enforceable.
- Consequence: a long conversion prevents even health/readiness handlers from running; concurrent exports can consume the same container budget without a bounded work queue. A small upload is not a bound on decompressed page/object complexity.
- If postponed: public traffic and larger input documents turn a local latency tradeoff into whole-service availability risk. Increasing rate-limit numbers or container memory does not fix the ownership boundary.
- Direction: keep the monolith, but run parsing in a worker/child process with page/object/output budgets and a killable deadline. Bound active and queued work for both export types as well as conversion, and release resources when callers cancel or work expires.
- Timing: **now**, before internet exposure. Desktop worker migration can be scheduled around supported document sizes.

### A4. Extracted images outlive the bounded model store indefinitely

- **Severity: HIGH. Evidence: CONFIRMED.**
- Evidence: engine/src/model/normalize.js:455 calls cacheImage; engine/src/model/images.js:18-19,31-37 writes content-addressed pixels to engine/.cache/images. server/lib/store.js:64-73 expires only Map entries. server/app.js:118-121 cleans request temporary directories, not the engine cache; the sweeper at :272-274 only sweeps models and rate limits. Docker mounts a limited tmpfs at /tmp, while this cache resides under /app/engine.
- Violated invariant: temporary uploaded-document assets must have an explicit retention lifetime and enforced resource ceiling.
- Consequence: each unique uploaded image remains on the container writable filesystem after the model expires; the model store's byte cap excludes those retained files. This also means temporary upload handling does not imply complete document-data deletion.
- If postponed: normal usage accumulates private extracted pixels and consumes host disk until cleanup/recreation or failure. No disk-exhaustion test was attempted.
- Direction: give document assets a bounded store with ownership/reference counts or per-document isolation, include their bytes in admission limits, and delete assets when no active model/export references them. Make retention behavior explicit and test TTL cleanup across both model and assets.
- Timing: **now**, before public hosted use.

## 5. Missing evidence

- Docker/ARM64 image build and runtime behavior remain unverified; Docker is unavailable on the development machine.
- No production deployment, recovery drill, or realistic concurrent workload was demonstrated.
- No browser-driven edited-PDF → PPTX content comparison was run during this architecture stage; A1 is directly established by source data flow.
- Parent review ran the existing hosted suite: 8/8 pass on Node v22.14.0 win32 x64, real 21-page/831-object lecture, valid PPTX/PDF outputs. These checks establish the initial conversion path, not edited-document correctness, capacity, or cleanup.
- Desktop baseline tests reported successful home flow, PDF import, and PDF output; packaged-install behavior is separate evidence still required.

## 6. Architecture debt watchlist

- In-memory model/session ownership and rate limits: acceptable for one process; reconsider on a second replica or requirements for restart-surviving sessions.
- Duplicated byte-identical editor/theme/doctor files: acceptable while sync is enforced; reconsider when shell-specific changes make divergence routine.
- Desktop synchronous PDF import: current 20-27-page timings are documented; move to a worker before substantially larger documents become a supported normal workflow.
- Reconstructed PDF and native HTML have different fidelity facts: retain both origins explicitly; revisit model schema when editable PDF round-tripping is designed.

## 7. Next review trigger

Review the delta after document identity/revision ownership, hosted worker isolation and asset lifetime are implemented, before first public deployment. A future tenancy model, multi-instance deployment or revised normalized-model schema also warrants review.
