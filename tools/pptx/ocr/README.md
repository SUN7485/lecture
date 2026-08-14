# Pinned bundled Tesseract payload (Windows x64)

This is the only permitted location for the offline Arabic + English OCR engine
used by `src/pptxTesseractOcr.js`. The checked-in payload is a reviewed,
version-pinned Windows x64 extraction. The app must fail closed if it is absent,
incomplete, corrupted, or cannot run. It must never use a system `PATH`
Tesseract, Python wrapper, network download, or substitute language/font/OCR
engine.

## Canonical source and integrity pins

| Asset | Pinned source | Size | Integrity identifier | License |
| --- | --- | ---: | --- | --- |
| Windows x64 engine input | `tesseract-ocr/tesseract` release `5.5.3`, `tesseract-ocr-w64-setup-5.5.3.20260724.exe` | 26,573,224 B | SHA-256 `bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4` | Apache-2.0, plus closure notices |
| Arabic model | `tesseract-ocr/tessdata_fast` commit `87416418657359cb625c412a48b6e1d6d41c29bd`, `ara.traineddata` | 1,432,056 B | Git blob SHA-1 `c8d129c67821c1592cac46836686b057ecc203dc` | Apache-2.0 |
| English model | `tesseract-ocr/tessdata_fast` commit `87416418657359cb625c412a48b6e1d6d41c29bd`, `eng.traineddata` | 4,113,088 B | Git blob SHA-1 `bbef4675053b5b468cdb477053e28b1c698ba08e` | Apache-2.0 |

Primary sources:

- <https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3>
- <https://github.com/tesseract-ocr/tesseract/blob/5.5.3/nsis/tesseract.nsi>
- <https://github.com/tesseract-ocr/tesseract/blob/5.5.3/nsis/build.sh>
- <https://github.com/tesseract-ocr/tesseract/blob/5.5.3/nsis/find_deps.py>
- <https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/ara.traineddata>
- <https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata>

## Required deployed tree

```text
tools/pptx/ocr/
  tesseract.exe
  libtesseract-5.dll
  libstdc++-6.dll
  libgcc_s_seh-1.dll
  <every recursively imported DLL emitted by upstream 5.5.3 nsis/find_deps.py>
  tessdata/
    ara.traineddata
    eng.traineddata
    configs/
      tsv
  LICENSES/
    Apache-2.0-Tesseract.txt
    Apache-2.0-tessdata_fast.txt
    BSD-2-Clause-Leptonica.txt
    <license/notice for every DLL in the actual closure>
  SHA256SUMS
```

The DLL line above is deliberately a **closure**, not an allow-list wildcard.
For the pinned upstream release, derive it recursively from `tesseract.exe` and
`libtesseract-5.dll` with upstream `nsis/find_deps.py`; upstream `nsis/build.sh`
also explicitly adds `libstdc++-6.dll` and `libgcc_s_seh-1.dll`. Copy every
resulting DLL from that same release build, and no DLL from a host installation.
This avoids guessing versioned DLL names and prevents a mixed-toolchain bundle.

At acquisition time, verify the installer SHA-256 above, extract only that
pinned release, then generate `SHA256SUMS` for every deployed `*.exe`, `*.dll`,
and `*.traineddata` file. The generated file must be reviewed and committed with
the binary payload. The installer checksum authenticates the source artifact;
the per-file `SHA256SUMS` authenticates the extracted closure. Do not replace
the pinned model blob identifiers with a moving `main` branch download.

`osd.traineddata`, training executables, documentation, PDF fonts, and unused
language/config packs are not part of the minimal payload. The adapter uses
upright 1900x1300 images, `ara+eng`, `--oem 1`, TSV output, and defaults to
page segmentation mode 3; changing that policy or adding optional data is a
deliberate manifest revision.

## License and notice obligations

Tesseract and `tessdata_fast` are Apache-2.0. Tesseract uses Leptonica, whose
license is BSD-2-Clause. The upstream Tesseract project explicitly notes that
other native dependencies can carry different licenses; retain the exact
license/notice for every DLL discovered in the pinned closure. Do not infer a
complete notice set from only the three named licenses above.

## Required fail-closed checks

The package pipeline must verify `SHA256SUMS` before shipping. At runtime,
`preflightBundledTesseractOcr()` must block export when any of these occurs:

- `tesseract.exe`, either traineddata file, or a closure DLL is missing.
- The package-integrity verification reports a missing or mismatched checksum.
- `tesseract.exe --version` cannot launch (including a missing DLL) or exits
  non-zero.
- `tesseract.exe --list-langs --tessdata-dir <bundle>/tessdata` does not report
  both `ara` and `eng`.
- Either source/PowerPoint OCR process times out, fails, or returns TSV without
  level-5 word rectangles.

No warning-only mode or alternate system OCR may make a rejected slide export.
The fidelity report must retain the adapter error code and diagnostic output for
the failed slide.
