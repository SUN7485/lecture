"""Create the deliberately unmistakable font used by the embed-travel proof.

``A`` is a near-em solid square while ``B`` is blank.  A fallback renderer
therefore produces ordinary letterforms; a renderer that consumed this exact
font produces an overwhelmingly dark text region without needing a second PC.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


FAMILY = "LVE Embed Proof"
UPM = 1000


def _blank_glyph():
    return TTGlyphPen(None).glyph()


def _solid_square():
    pen = TTGlyphPen(None)
    # Slight insets make the test robust to antialiasing and avoid a clipped
    # edge being mistaken for an ordinary fallback glyph.
    pen.moveTo((75, 50))
    pen.lineTo((925, 50))
    pen.lineTo((925, 950))
    pen.lineTo((75, 950))
    pen.closePath()
    return pen.glyph()


def build(output_path):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    glyph_order = [".notdef", "space", "A", "B"]
    glyphs = {
        ".notdef": _blank_glyph(),
        "space": _blank_glyph(),
        "A": _solid_square(),
        "B": _blank_glyph(),
    }
    builder = FontBuilder(UPM, isTTF=True)
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap({0x20: "space", 0x41: "A", 0x42: "B"})
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({
        ".notdef": (UPM, 0),
        "space": (500, 0),
        "A": (UPM, 75),
        "B": (UPM, 0),
    })
    builder.setupHorizontalHeader(ascent=UPM, descent=0, lineGap=0)
    builder.setupNameTable({
        "familyName": FAMILY,
        "styleName": "Regular",
        "uniqueFontIdentifier": "Lecture Visual Editor: " + FAMILY + " Regular",
        "fullName": FAMILY,
        "psName": "LVE-Embed-Proof",
        "version": "Version 1.000",
    })
    builder.setupOS2(
        fsType=0,
        usWeightClass=400,
        sTypoAscender=UPM,
        sTypoDescender=0,
        sTypoLineGap=0,
        usWinAscent=UPM,
        usWinDescent=0,
    )
    builder.setupPost()
    builder.setupMaxp()
    builder.save(output_path)
    return output_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    print(build(arguments.output))


if __name__ == "__main__":
    main()
