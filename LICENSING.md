# Licensing — UNRESOLVED, read before distributing anything

**Status: this app must not be distributed to anyone in its current form.**
It runs locally. That is the only use it is currently licensed for.

## The conflict

`package.json` declares this project **MIT**. That declaration is now false for
the app as a whole, and has been since the PDF engine was vendored in.

| Component | Licence | Where |
|---|---|---|
| Lecture Visual Editor (this app's own code) | MIT | `src/`, `web/`, `tools/` |
| PDF reconstruction engine (vendored) | inherits below | `engine/` |
| **`mupdf@1.28.0`** | **AGPL-3.0-or-later** | `node_modules/mupdf` |

MuPDF is published by Artifex under AGPL-3.0-or-later. Verified in the package
itself:

```
node_modules/mupdf/package.json  ->  "license": "AGPL-3.0-or-later"
```

The AGPL is copyleft and its network clause is aggressive. Bundling MuPDF into
a distributed application means the **entire combined work** must be released
under the AGPL, including this app's own source — and if it is ever offered
over a network, to every user of that service.

## What that rules out today

- Shipping the NSIS installer (`npm run dist`) to anyone.
- Publishing a build, even free of charge, without AGPL-releasing all of it.
- Any hosted or web version.
- Any commercial/closed licence for the product as it stands.

Running it on your own machine, which is what it does now, is fine.

## The three ways out

1. **Release the whole thing under AGPL-3.0-or-later.** Free, immediate,
   and irreversible in practice. Fine if the product is never closed-source.
2. **Buy a commercial MuPDF licence from Artifex.** Artifex dual-licenses
   exactly for this case. Costs money; keeps the app's licence your choice.
   This is the normal answer for a product you intend to sell.
3. **Replace MuPDF with `pdfjs-dist` (Apache-2.0).** Already a dependency of
   the source engine. **Do not assume this is a swap.** The engine's hardest
   work reads MuPDF-specific surfaces — device-level vector extraction with
   colorspace arity, Type3 font descriptors, per-glyph provenance, the
   structured-text walker. Re-deriving those on pdf.js is a rewrite of the
   part of this codebase that took the longest to get right.

## Also unaudited

- **Embedded fonts.** `engine/src/fonts/license.js` reads `fsType` and knows
  that some faces (measured: Diodrum Arabic, Lyon Arabic Text LF — fsType 4,
  "preview & print") may not be embedded into an editable document at all.
  Any font shipped with a build needs the same check applied to it.
- `src/fonts/` in this app carries brand font files. Confirm the redistribution
  terms of each before packaging.

## Decision log

- **2026-09-01** — Merge performed with the conflict knowingly unresolved, on
  the owner's explicit instruction ("proceed, flag it, decide later"). The MIT
  string in `package.json` was deliberately left untouched rather than silently
  changed; it is wrong, and this file is the record that it is wrong. Nothing
  has been distributed.
