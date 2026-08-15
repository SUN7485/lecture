"""Prepare browser-supplied font bytes for PowerPoint embedding.

PowerPoint accepts TrueType-outline fonts in an embedded ``.fntdata`` part.
Theme kits, however, can provide CFF OpenType or WOFF2 data URLs.  This module
turns those inputs into standalone TrueType bytes without ever changing the
original asset, and makes an embedding decision that honours the OpenType
embedding permission bit.
"""

from __future__ import annotations

from io import BytesIO

from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.woff2 import decompress as decompress_woff2


RESTRICTED_EMBEDDING_BIT = 0x0002


def _name(font: TTFont, primary: int, alternate: int) -> str:
    """Read a Unicode name-table value, preferring the legacy Windows name."""
    table = font.get("name")
    if table is None:
        return ""
    for name_id in (primary, alternate):
        for record in table.names:
            if record.nameID != name_id:
                continue
            try:
                value = record.toUnicode().strip()
            except Exception:
                continue
            if value:
                return value
    return ""


def _cff_to_glyf(font: TTFont) -> None:
    """Replace cubic CFF outlines with quadratic TrueType outlines in-place."""
    glyph_set = font.getGlyphSet()
    glyph_order = font.getGlyphOrder()
    glyf = newTable("glyf")
    glyf.glyphs = {}
    glyf.glyphOrder = glyph_order

    for glyph_name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        glyph_set[glyph_name].draw(Cu2QuPen(pen, max_err=1.0, all_quadratic=True))
        glyf.glyphs[glyph_name] = pen.glyph()

    font["glyf"] = glyf
    # FontTools recalculates maxp while saving.  The freshly drawn Glyph
    # objects have no cached bounds until we ask for them, which otherwise
    # makes that calculation fail before the font has reached OOXML.
    for glyph in glyf.glyphs.values():
        glyph.recalcBounds(glyf)
    font["loca"] = newTable("loca")
    del font["CFF "]

    # CFF fonts carry a compact maxp 0.5 table.  TrueType glyf needs maxp 1.0.
    # FontTools recalculates the outline-related values at save time, while the
    # instruction-related values have no CFF equivalent and must be initialized.
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for attribute, value in {
        "maxPoints": 0,
        "maxContours": 0,
        "maxCompositePoints": 0,
        "maxCompositeContours": 0,
        "maxZones": 2,
        "maxTwilightPoints": 0,
        "maxStorage": 0,
        "maxFunctionDefs": 0,
        "maxInstructionDefs": 0,
        "maxStackElements": 0,
        "maxSizeOfInstructions": 0,
        "maxComponentElements": 0,
        "maxComponentDepth": 0,
    }.items():
        setattr(maxp, attribute, value)


def _load(font_bytes: bytes, mime: str) -> TTFont:
    """Load a data-URL font, expanding WOFF2 before FontTools parses it."""
    raw = bytes(font_bytes or b"")
    if not raw:
        raise ValueError("font data is empty")
    if "woff2" in str(mime or "").lower() or raw[:4] == b"wOF2":
        expanded = BytesIO()
        decompress_woff2(BytesIO(raw), expanded)
        raw = expanded.getvalue()
    return TTFont(BytesIO(raw), recalcBBoxes=False, recalcTimestamp=False)


def prepare(font_bytes: bytes, mime: str) -> dict:
    """Return embeddable TTF bytes and metadata, or an honest skip reason.

    The return shape deliberately stays JSON-friendly so ``fonts.py`` can pass
    skipped-font details through the renderer result without serializing binary
    data.  ``fsType`` is retained for reports even when it does not prevent
    embedding.
    """
    result = {
        "ttf_bytes": None,
        "family": "",
        "subfamily": "",
        "fsType": 0,
        "skipped_reason": None,
    }
    try:
        font = _load(font_bytes, mime)
        result["family"] = _name(font, 1, 16)
        result["subfamily"] = _name(font, 2, 17)
        os2 = font.get("OS/2")
        result["fsType"] = int(getattr(os2, "fsType", 0) or 0)
        if result["fsType"] & RESTRICTED_EMBEDDING_BIT:
            result["skipped_reason"] = "license restricted (fsType)"
            return result

        if "CFF " in font:
            _cff_to_glyf(font)

        # WOFF/WOFF2 are web containers, not embed-ready TrueType files.  A
        # plain save after loading strips that container flavour; setting this
        # explicitly also protects against a font supplied as WOFF.
        font.flavor = None
        output = BytesIO()
        font.save(output)
        ttf_bytes = output.getvalue()
        # Validate our own emitted data before it gets anywhere near OOXML.
        check = TTFont(BytesIO(ttf_bytes), recalcBBoxes=False, recalcTimestamp=False)
        if "glyf" not in check:
            raise ValueError("font does not contain TrueType glyf outlines after preparation")
        result["ttf_bytes"] = ttf_bytes
        return result
    except Exception as error:
        result["skipped_reason"] = "font preparation failed: %s" % str(error)
        return result
