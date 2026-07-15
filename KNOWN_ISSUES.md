# KNOWN ISSUES — every known-unfixed bug, with its trigger
<!-- If it bit us once and isn't fixed, it lives here until it is. -->

- **Gemini image model quota** (Electron Studio image lab): image generation fails on quota. Trigger: any image-lab generate in `src/studio/`. Needs quota fix / key upgrade. Parked since web pivot.
- **Electron doctor dock still on old row UI** (accepted, follow-up): `src/renderer.js` renders the pre-v4 per-issue row list. It consumes the new engine fine (shared `doctor.js`, `analyze()` shape unchanged) so findings are correct, but it doesn't use `aggregate()` cards. Trigger: opening 🩺 in the Electron app. Port 018B's `doctorCard()` + dark CSS to `src/renderer.js` when the desktop dock matters.
- **Doctor chip focus-scroll needs real Chrome** (not a bug): `focusIssue()` uses `scrollTo({behavior:'smooth'})`, which the in-app preview browser doesn't animate (flash-outline still fires, proving the wiring). Renders/scrolls normally in a real browser. Trigger: verifying chip-click scrolling via the preview pane — check the flash, not the scrollTop.
- **Deck-CSS specificity beats kit fonts** (accepted limit, by design): decks whose own CSS targets titles with higher specificity than `.slide h1` keep their font when a kit/typography is applied. Trigger: imported decks with aggressive stylesheets. Popover live sample makes it visible; no fix planned.
