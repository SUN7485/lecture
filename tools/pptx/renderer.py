import json
import sys
import re
import os
import tempfile
import base64
import shutil
import subprocess
from lxml import etree
from html.parser import HTMLParser
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE
from pptx.chart.data import ChartData
from pptx.enum.chart import XL_CHART_TYPE

from rtl import set_rtl
from fonts import extract_fonts_from_theme, embed_fonts


# Slide dimensions: 950x650 px at 96 DPI
SLIDE_WIDTH_PX = 950
SLIDE_HEIGHT_PX = 650
SLIDE_WIDTH_IN = SLIDE_WIDTH_PX / 96
SLIDE_HEIGHT_IN = SLIDE_HEIGHT_PX / 96

# Margins (matching CSS: padding 45px 60px 110px 60px)
MARGIN_LEFT_PX = 60
MARGIN_TOP_PX = 45
MARGIN_BOTTOM_PX = 110
MARGIN_RIGHT_PX = 60

CONTENT_WIDTH_PX = SLIDE_WIDTH_PX - MARGIN_LEFT_PX - MARGIN_RIGHT_PX
CONTENT_HEIGHT_PX = SLIDE_HEIGHT_PX - MARGIN_TOP_PX - MARGIN_BOTTOM_PX


def px_to_emu(px):
    return Emu(int(px * 9525))


def px_to_in(px):
    return Inches(px / 96)


def extract_theme_colors(theme_css):
    """Extract CSS custom property colors from theme CSS."""
    colors = {}
    if not theme_css:
        return colors
    for m in re.finditer(r'--([\w-]+)\s*:\s*([^;}\n]+)', theme_css, re.IGNORECASE):
        name = m.group(1).lower()
        val = m.group(2).strip()
        if re.match(r'^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$', val, re.IGNORECASE):
            colors[name] = val
        elif re.match(r'^rgb(a?)\(', val, re.IGNORECASE):
            colors[name] = val
    return colors


def resolve_color(raw, theme_colors, fallback_hex):
    """Resolve a color value that may be a CSS var, rgb(), or hex."""
    if not raw:
        return fallback_hex
    raw = raw.strip()
    if raw.startswith('var('):
        var_name = re.search(r'var\((--[^)]+)\)', raw)
        if var_name:
            return theme_colors.get(var_name.group(1).lower(), fallback_hex)
        return fallback_hex
    if re.match(r'^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$', raw, re.IGNORECASE):
        return raw
    if re.match(r'^rgb(a?)\(', raw, re.IGNORECASE):
        return raw
    return fallback_hex


def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join([c * 2 for c in hex_str])
    r = int(hex_str[0:2], 16)
    g = int(hex_str[2:4], 16)
    b = int(hex_str[4:6], 16)
    return RGBColor(r, g, b)


def rgb_str_to_rgb(rgb_str):
    m = re.match(r'rgb(a?)\(([^)]+)\)', rgb_str, re.IGNORECASE)
    if not m:
        return None
    parts = [p.strip() for p in m.group(2).split(',')]
    if len(parts) < 3:
        return None
    r = int(parts[0])
    g = int(parts[1])
    b = int(parts[2])
    return RGBColor(r, g, b)


def color_to_rgb(color_str, fallback_hex):
    if not color_str:
        return hex_to_rgb(fallback_hex)
    color_str = color_str.strip()
    if color_str.startswith('#'):
        return hex_to_rgb(color_str)
    if color_str.lower().startswith('rgb'):
        rgb = rgb_str_to_rgb(color_str)
        if rgb:
            return rgb
    return hex_to_rgb(fallback_hex)


class TextRunParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.runs = []
        self._text = ''
        self._bold = False
        self._italic = False
        self._color = None
    
    def handle_starttag(self, tag, attrs):
        if tag in ('strong', 'b'):
            self._flush()
            self._bold = True
        elif tag in ('em', 'i'):
            self._flush()
            self._italic = True
        for name, value in attrs:
            if name == 'style' and value:
                color_match = re.search(r'color\s*:\s*([^;]+)', value, re.IGNORECASE)
                if color_match:
                    self._flush()
                    self._color = color_match.group(1).strip()
    
    def handle_endtag(self, tag):
        if tag in ('strong', 'b'):
            self._flush()
            self._bold = False
            self._color = None
        elif tag in ('em', 'i'):
            self._flush()
            self._italic = False
            self._color = None
        elif tag == 'span':
            self._flush()
            self._color = None
    
    def handle_data(self, data):
        self._text += data
    
    def _flush(self):
        if self._text:
            self.runs.append((self._text, self._bold, self._italic, self._color))
            self._text = ''
    
    def get_runs(self):
        self._flush()
        return self.runs


def parse_html_runs(html_text):
    parser = TextRunParser()
    parser.feed(html_text or '')
    return parser.get_runs()


def apply_runs_to_paragraph(p, runs, font_name, font_size_pt, color_rgb=None, theme_colors=None):
    p.clear()
    for i, (text, bold, italic, run_color) in enumerate(runs):
        if i == 0 and p.runs:
            run = p.runs[0]
        else:
            run = p.add_run()
        run.text = text
        run.font.name = font_name
        run.font.size = Pt(font_size_pt)
        if bold:
            run.font.bold = True
        if italic:
            run.font.italic = True
        resolved = None
        if run_color:
            resolved = resolve_color(run_color, theme_colors or {}, None)
        # RGBColor is a bytes subclass and may be falsey; test explicitly so
        # computed CSS colors are never silently discarded.
        if resolved is None and color_rgb is not None:
            resolved = color_rgb
        if resolved:
            if isinstance(resolved, str) and resolved.startswith('#'):
                run.font.color.rgb = hex_to_rgb(resolved)
            elif isinstance(resolved, str) and resolved.lower().startswith('rgb'):
                rgb = rgb_str_to_rgb(resolved)
                if rgb:
                    run.font.color.rgb = rgb
            elif isinstance(resolved, RGBColor):
                run.font.color.rgb = resolved


def add_text_box(slide, left_px, top_px, width_px, height_px, text_html, font_name, font_size_pt, rtl=True, alignment=PP_ALIGN.RIGHT, color=None, theme_colors=None):
    txBox = slide.shapes.add_textbox(
        px_to_emu(left_px), px_to_emu(top_px),
        px_to_emu(width_px), px_to_emu(height_px)
    )
    tf = txBox.text_frame
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = alignment
    if rtl:
        set_rtl(p)
    apply_runs_to_paragraph(p, parse_html_runs(text_html), font_name, font_size_pt, color, theme_colors)
    return txBox


def add_list(slide, left_px, top_px, width_px, height_px, items_html, font_name, font_size_pt, rtl=True, ordered=False, color=None):
    txBox = slide.shapes.add_textbox(
        px_to_emu(left_px), px_to_emu(top_px),
        px_to_emu(width_px), px_to_emu(height_px)
    )
    tf = txBox.text_frame
    tf.word_wrap = True
    for i, item_html in enumerate(items_html):
        if i == 0:
            p = tf.paragraphs[0]
        else:
            p = tf.add_paragraph()
        p.alignment = PP_ALIGN.RIGHT if rtl else PP_ALIGN.LEFT
        if rtl:
            set_rtl(p)
        # Add bullet/number prefix
        prefix = f"{i+1}. " if ordered else "• "
        apply_runs_to_paragraph(p, [(prefix + (item_html or ''), False, False, None)], font_name, font_size_pt, color)
    return txBox


def add_table(slide, left_px, top_px, width_px, height_px, table_data, font_name, font_size_pt, rtl=True, color=None, theme_colors=None):
    headers = table_data.get('headers', [])
    rows = table_data.get('rows', [])
    num_rows = 1 + len(rows) if headers else len(rows)
    num_cols = len(headers) if headers else (len(rows[0]) if rows else 0)
    
    if num_rows == 0 or num_cols == 0:
        return None
    
    table_shape = slide.shapes.add_table(
        num_rows, num_cols,
        px_to_emu(left_px), px_to_emu(top_px),
        px_to_emu(width_px), px_to_emu(height_px)
    )
    table = table_shape.table
    
    # Set column widths evenly
    for col_idx in range(num_cols):
        table.columns[col_idx].width = px_to_emu(width_px) // num_cols
    
    header_fill = resolve_color((theme_colors or {}).get('purple', '#413258'), theme_colors or {}, '#413258')
    header_text_color = '#FFFFFF'
    
    row_idx = 0
    if headers:
        for col_idx, header_html in enumerate(headers):
            cell = table.cell(0, col_idx)
            cell.fill.solid()
            cell.fill.fore_color.rgb = color_to_rgb(header_fill, '#413258')
            for p in cell.text_frame.paragraphs:
                p.alignment = PP_ALIGN.RIGHT if rtl else PP_ALIGN.LEFT
                if rtl:
                    set_rtl(p)
                apply_runs_to_paragraph(p, parse_html_runs(header_html), font_name, font_size_pt, color_to_rgb(header_text_color, '#FFFFFF'), theme_colors)
            for run in cell.text_frame.paragraphs[0].runs:
                run.font.bold = True
        row_idx = 1
    
    for row_data in rows:
        for col_idx, cell_html in enumerate(row_data):
            cell = table.cell(row_idx, col_idx)
            for p in cell.text_frame.paragraphs:
                p.alignment = PP_ALIGN.RIGHT if rtl else PP_ALIGN.LEFT
                if rtl:
                    set_rtl(p)
                apply_runs_to_paragraph(p, parse_html_runs(cell_html), font_name, font_size_pt, color, theme_colors)
        row_idx += 1
    
    return table_shape


def add_figure(slide, left_px, top_px, width_px, height_px, figure_data, enrich, base_dir, theme_colors=None, align='center'):
    img_src = None
    svg_markup = None
    caption = ''
    kind = figure_data.get('kind', 'figure')
    prop_id = figure_data.get('propId', '')

    # Try inline HTML first (e.g. <img src="data:image/png;base64,..."> or <svg>...</svg>)
    html = figure_data.get('html', '')
    if html:
        m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html, re.IGNORECASE)
        if m:
            img_src = m.group(1)
        if not img_src and re.search(r'<svg[^>]*>', html, re.IGNORECASE):
            svg_markup = html

    # Fallback to enrich cache result
    if not img_src and not svg_markup and enrich:
        try:
            key = f"{prop_id}:{kind}"
            entry = None
            if isinstance(enrich, dict):
                entry = ((enrich.get('v2') or {}).get(key))
                if not entry:
                    for k, v in (enrich.get('v2') or {}).items():
                        if k.endswith(key):
                            entry = v
                            break
            if entry and entry.get('result'):
                r = entry['result']
                if isinstance(r, dict):
                    if r.get('html'):
                        m2 = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', r['html'], re.IGNORECASE)
                        if m2:
                            img_src = m2.group(1)
                        elif re.search(r'<svg[^>]*>', r['html'], re.IGNORECASE):
                            svg_markup = r['html']
                    caption = r.get('caption', '') or caption
        except Exception:
            pass

    # Handle SVG markup (diagrams, equations, charts)
    if svg_markup and not img_src:
        try:
            svg_bytes = svg_markup.encode('utf-8')
            with tempfile.NamedTemporaryFile(suffix='.svg', delete=False) as tmp_svg:
                tmp_svg.write(svg_bytes)
                svg_path = tmp_svg.name
            try:
                png_path = svg_path + '.png'
                ok, _, _ = convert_svg_to_png(svg_path, png_path)
                if not ok and not os.path.exists(png_path):
                    make_placeholder_png(png_path, width_px, 120, kind)
                if os.path.exists(png_path):
                    place_picture(slide, png_path, left_px, top_px, width_px, height_px, align)
                    return
            except Exception:
                pass
            finally:
                try:
                    os.unlink(svg_path)
                except Exception:
                    pass
                try:
                    if os.path.exists(svg_path + '.png'):
                        os.unlink(svg_path + '.png')
                except Exception:
                    pass
        except Exception:
            pass

    # Handle image source (data URL or file path)
    if img_src:
        if img_src.startswith('data:'):
            try:
                header, b64 = img_src.split(',', 1)
                ext = '.png'
                if 'svg+xml' in header:
                    ext = '.svg'
                elif 'jpeg' in header or 'jpg' in header:
                    ext = '.jpg'
                elif 'webp' in header:
                    ext = '.webp'
                elif 'gif' in header:
                    ext = '.gif'
                img_bytes = base64.b64decode(b64)
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                    tmp.write(img_bytes)
                    tmp_path = tmp.name
                try:
                    if ext == '.svg':
                        png_path = tmp_path + '.png'
                        ok, _, _ = convert_svg_to_png(tmp_path, png_path)
                        if not ok and not os.path.exists(png_path):
                            make_placeholder_png(png_path, width_px, 120, 'image')
                        if os.path.exists(png_path):
                            place_picture(slide, png_path, left_px, top_px, width_px, height_px, align)
                        else:
                            place_picture(slide, tmp_path, left_px, top_px, width_px, height_px, align)
                    else:
                        place_picture(slide, tmp_path, left_px, top_px, width_px, height_px, align)
                    return
                finally:
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass
                    try:
                        if os.path.exists(tmp_path + '.png'):
                            os.unlink(tmp_path + '.png')
                    except Exception:
                        pass
            except Exception:
                pass
        else:
            # Relative or absolute file path
            try:
                if base_dir and not os.path.isabs(img_src):
                    candidate = os.path.join(base_dir, img_src)
                else:
                    candidate = img_src
                if os.path.exists(candidate):
                    if candidate.lower().endswith('.svg'):
                        png_path = candidate + '.png'
                        try:
                            ok, _, _ = convert_svg_to_png(candidate, png_path)
                            if not ok and not os.path.exists(png_path):
                                make_placeholder_png(png_path, width_px, 120, kind)
                            if os.path.exists(png_path):
                                place_picture(slide, png_path, left_px, top_px, width_px, height_px, align)
                            else:
                                place_picture(slide, candidate, left_px, top_px, width_px, height_px, align)
                        finally:
                            if os.path.exists(png_path):
                                try:
                                    os.unlink(png_path)
                                except Exception:
                                    pass
                    else:
                        place_picture(slide, candidate, left_px, top_px, width_px, height_px, align)
                    return
            except Exception:
                pass

    # Fallback: placeholder text box with caption
    label = caption or kind or 'figure'
    if prop_id:
        label += f' ({prop_id})'
    return add_text_box(
        slide, left_px, top_px, width_px, height_px,
        f'[{label}]',
        'Cairo', 12, rtl=False, color=RGBColor(0x88, 0x88, 0x88), theme_colors=theme_colors
    )


def svg_natural_size(svg_path):
    """Parse the SVG's width/height/viewBox to its intrinsic pixel size."""
    try:
        import xml.etree.ElementTree as ET
        root = ET.parse(svg_path).getroot()
        vb = root.get('viewBox')
        units = {'px': 1.0, 'pt': 96.0 / 72.0, 'in': 96.0, 'cm': 96.0 / 2.54,
                 'mm': 96.0 / 25.4, 'em': 16.0, 'ex': 8.0}

        def to_px(v):
            if not v:
                return None
            v = str(v).strip()
            if v.endswith('%'):
                return None
            m = re.match(r'^([\d.]+)([a-z%]*)$', v, re.IGNORECASE)
            if not m:
                return None
            val = float(m.group(1))
            unit = m.group(2).lower()
            return val * units.get(unit, 1.0)

        sw, sh = to_px(root.get('width')), to_px(root.get('height'))
        if vb:
            parts = vb.replace(',', ' ').split()
            if len(parts) >= 4:
                vw, vh = float(parts[2]), float(parts[3])
                if vw > 0 and not sw:
                    sw = vw
                if vh > 0 and not sh:
                    sh = vh
        if sw and sh and sw > 0 and sh > 0:
            return (sw, sh)
        return None
    except Exception:
        return None


def png_size(png_path):
    try:
        from PIL import Image
        im = Image.open(png_path)
        s = im.size
        im.close()
        return s
    except Exception:
        return None


def make_placeholder_png(png_path, width, height, label):
    """A labelled, obviously-placeholder raster so an un-rasterisable SVG is
    still loudly visible on the slide instead of silently dropping out."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        im = Image.new('RGB', (max(1, int(width)), max(1, int(height))), '#FAFAFC')
        d = ImageDraw.Draw(im)
        d.rectangle([2, 2, im.width - 3, im.height - 3], outline='#B3B3B3', width=3)
        txt = '[SVG not rasterised — %s]' % label
        try:
            font = ImageFont.load_default(size=12)
            d.rectangle([0, max(0, im.height // 2 - 12), im.width, im.height], fill='#FAFAFC')
            bbox = d.textbbox((0, 0), txt, font=font)
            w = bbox[2] - bbox[0]
            d.text(((im.width - w) / 2, im.height / 2 - 10), txt,
                   fill='#413258', font=font)
        except Exception:
            pass
        im.save(png_path, 'PNG')
        return True
    except Exception:
        return False


def convert_svg_to_png(svg_path, png_path):
    """Rasterise SVG -> PNG via cairosvg (installed), then inkscape /
    rsvg-convert as a backup, then a labelled placeholder PNG. The placeholder
    keeps failures VISIBLE instead of an empty box. Returns (ok, out_w, out_h)."""
    nat = svg_natural_size(svg_path) or (800, 600)
    tw, th = int(round(nat[0])), int(round(nat[1]))
    # Cap very large SVGs so the produced PNG stays sane in size.
    cap = 2400.0
    scale = min(1.0, cap / max(tw, 1))
    tw, th = max(1, int(round(tw * scale))), max(1, int(round(th * scale)))

    # 1) cairosvg (preferred, now installed).
    try:
        import cairosvg
        cairosvg.svg2png(url=Path(svg_path).as_uri(),
                         write_to=png_path, output_width=tw, output_height=th)
        if png_size(png_path):
            return True, tw, th
    except Exception:
        pass

    # 2) inkscape / rsvg-convert fallback.
    for exe in ('inkscape', 'inkscape.com', 'rsvg-convert'):
        runner = shutil.which(exe)
        if not runner:
            continue
        try:
            if 'inkscape' in exe:
                cmd = [runner, '--export-type=png', '--export-filename=' + png_path,
                       '--export-width=' + str(tw), svg_path]
            else:
                cmd = [runner, '-w', str(tw), '-h', str(th), '-o', png_path, svg_path]
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            size = png_size(png_path)
            if size:
                return True, size[0], size[1]
        except Exception:
            continue

    # 3) Labelled placeholder so a rasterisation failure is visible, not silent.
    if make_placeholder_png(png_path, tw, th, os.path.basename(svg_path)):
        return False, tw, th
    return False, tw, th


def place_picture(slide, img_path, left_px, top_px, box_w, box_h, align='center'):
    """Add a picture preserving aspect ratio, anchored within the box by align:
    'left' / 'right' / 'center' (the ve-align classes)."""
    w, h = box_w, box_h
    size = png_size(img_path)
    if size:
        iw, ih = size
        if iw > 0 and ih > 0:
            scale = min(box_w / iw, box_h / ih)
            w, h = iw * scale, ih * scale
    w = max(1.0, min(w, box_w))
    h = max(1.0, min(h, box_h))
    if align == 'left':
        x = left_px
    elif align == 'right':
        x = left_px + (box_w - w)
    else:
        x = left_px + (box_w - w) / 2
    y = top_px + (box_h - h) / 2
    return slide.shapes.add_picture(img_path, px_to_emu(x), px_to_emu(y),
                                    px_to_emu(w), px_to_emu(h))


def add_line(slide, left_px, top_px, width_px, height_px, color_hex, thickness_px=3):
    shape = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        px_to_emu(left_px), px_to_emu(top_px),
        px_to_emu(width_px), px_to_emu(thickness_px)
    )
    shape.fill.background()
    try:
        r = int(color_hex[1:3], 16)
        g = int(color_hex[3:5], 16)
        b = int(color_hex[5:7], 16)
    except Exception:
        r, g, b = 0x44, 0x44, 0x44
    shape.line.color.rgb = RGBColor(r, g, b)
    shape.line.width = Emu(int(thickness_px * 9525))
    return shape


def add_shape(slide, left_px, top_px, width_px, height_px, shape_data):
    shape_type = shape_data.get('shapeType', 'rectangle')
    fill = shape_data.get('fill', '#E0E0E0')
    stroke = shape_data.get('stroke', '#000000')
    text = shape_data.get('text', '')

    shape = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        px_to_emu(left_px), px_to_emu(top_px),
        px_to_emu(width_px), px_to_emu(height_px)
    )
    try:
        r = int(fill[1:3], 16)
        g = int(fill[3:5], 16)
        b = int(fill[5:7], 16)
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(r, g, b)
    except Exception:
        shape.fill.background()
    try:
        r = int(stroke[1:3], 16)
        g = int(stroke[3:5], 16)
        b = int(stroke[5:7], 16)
        shape.line.color.rgb = RGBColor(r, g, b)
        shape.line.width = Emu(int(1.5 * 9525))
    except Exception:
        shape.line.fill.background()

    if text:
        tf = shape.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        p.text = text
        for run in p.runs:
            run.font.name = 'Cairo'
            run.font.size = Pt(14)
    return shape


def add_html_block(slide, left_px, top_px, width_px, height_px, html, font_name, font_size_pt, rtl=True, theme_colors=None):
    """Render arbitrary HTML as a text box (for div blocks, math steps, etc.)."""
    clean = re.sub(r'<[^>]+>', '', html)
    clean = re.sub(r'&nbsp;', ' ', clean)
    clean = clean.strip()
    if not clean:
        return None
    return add_text_box(slide, left_px, top_px, width_px, height_px, clean,
                        font_name, font_size_pt, rtl=rtl, theme_colors=theme_colors)


def add_quiz(slide, left_px, top_px, width_px, height_px, quiz_html, font_name, font_size_pt, rtl=True, theme_colors=None):
    """Render quiz HTML as a group of text boxes."""
    text = re.sub(r'<[^>]+>', ' ', quiz_html)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return None
    lines = text.split('. ') if '. ' in text else [text]
    y = top_px
    h = height_px / max(len(lines), 1)
    for line in lines[:8]:
        line = line.strip()
        if not line:
            continue
        add_text_box(slide, left_px, y, width_px, h, line,
                     font_name, font_size_pt, rtl=rtl, theme_colors=theme_colors)
        y += h
    return True


GENERIC_FAMILIES = {'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
                    'system-ui', 'inherit', 'initial', 'unset', 'revert'}


def norm_family(name, default):
    """Normalise a CSS font-family name for use as a PPTX font name, ignoring
    generic/system families that say nothing useful to PowerPoint."""
    name = (name or '').strip().strip('"\'').strip()
    if not name or name.lower() in GENERIC_FAMILIES:
        return default
    return name[:60]


def item_font_size(item, default):
    """Per-item font size in points (=== px at 96dpi), captured from the live
    CSS by the editor. Falls back to the caller's default when absent."""
    if isinstance(item, dict):
        try:
            v = float(item.get('fs'))
            if v > 0:
                # Browsers use CSS pixels at 96 dpi; PowerPoint uses points
                # at 72 dpi. Treating px as pt made every export 33% too big.
                return v * 0.75
        except (TypeError, ValueError):
            pass
    return default


def item_box(item, fallback):
    """Return a browser-measured element box, or the legacy fallback."""
    box = item.get('box') if isinstance(item, dict) else None
    if isinstance(box, dict):
        try:
            return (float(box['x']), float(box['y']), max(1, float(box['w'])), max(1, float(box['h'])))
        except (KeyError, TypeError, ValueError):
            pass
    return fallback


def item_alignment(item, rtl=True):
    value = (item.get('align') or '').lower() if isinstance(item, dict) else ''
    if value in ('left', 'start'):
        return PP_ALIGN.LEFT
    if value in ('center', 'centre'):
        return PP_ALIGN.CENTER
    if value in ('justify',):
        return PP_ALIGN.JUSTIFY
    return PP_ALIGN.RIGHT if rtl else PP_ALIGN.LEFT


def item_color(item, fallback, theme_colors):
    return color_to_rgb(resolve_color(item.get('color'), theme_colors or {}, fallback), fallback)


def add_filled_rect(slide, x, y, w, h, color):
    """Add a native PowerPoint rectangle used for a CSS background/border."""
    if not color or color in ('transparent', 'rgba(0, 0, 0, 0)'):
        return None
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = color_to_rgb(color, '#FFFFFF')
    shape.line.fill.background()
    return shape


def add_precise_text(slide, item, html, default_font, default_size, theme_colors, rtl=True):
    x, y, w, h = item_box(item, (MARGIN_LEFT_PX, MARGIN_TOP_PX, CONTENT_WIDTH_PX, 40))
    if item.get('bg') and item.get('bg') not in ('transparent', 'rgba(0, 0, 0, 0)'):
        add_filled_rect(slide, x, y, w, h, item['bg'])
    return add_text_box(slide, x, y, w, h, html,
                        norm_family(item.get('ff'), default_font),
                        item_font_size(item, default_size), rtl=rtl,
                        alignment=item_alignment(item, rtl),
                        color=item_color(item, '#000000', theme_colors),
                        theme_colors=theme_colors)


def add_slide_borders(slide, style):
    for side, x in (('borderLeft', 0), ('borderRight', SLIDE_WIDTH_PX)):
        value = (style or {}).get(side, '')
        m = re.search(r'([\d.]+)px\s+(?:solid|double)\s+([^;]+)', value, re.I)
        if not m:
            continue
        width = float(m.group(1))
        color = m.group(2).strip()
        add_filled_rect(slide, x if side == 'borderLeft' else x - width, 0, width, SLIDE_HEIGHT_PX, color)


def render_precise_slide(slide, slide_data, enrich, base_dir, default_font, theme_colors):
    """Render elements at browser-computed coordinates, preserving native editability."""
    style = slide_data.get('slideStyle') or {}
    add_filled_rect(slide, 0, 0, SLIDE_WIDTH_PX, SLIDE_HEIGHT_PX, style.get('bg', '#FFFFFF'))
    add_slide_borders(slide, style)

    for key, text, default_size, rtl in (
        ('h1Style', slide_data.get('h1'), 28, True),
        ('h2Style', slide_data.get('h2'), 20, True),
        ('footerLeftStyle', slide_data.get('footerLeft'), 10, False),
        ('footerRightStyle', slide_data.get('footerRight'), 10, True),
        ('footerSiteStyle', slide_data.get('footerSite'), 8, False),
    ):
        if text:
            add_precise_text(slide, slide_data.get(key) or {}, text, default_font, default_size, theme_colors, rtl)

    for item in slide_data.get('content', []):
        kind = item.get('type')
        x, y, w, h = item_box(item, (MARGIN_LEFT_PX, MARGIN_TOP_PX, CONTENT_WIDTH_PX, 50))
        if kind == 'paragraph':
            add_precise_text(slide, item, item.get('html', ''), default_font, 16, theme_colors, item.get('direction') != 'ltr')
        elif kind == 'list':
            add_list(slide, x, y, w, h, item.get('items', []), norm_family(item.get('ff'), default_font),
                     item_font_size(item, 16), rtl=item.get('direction') != 'ltr', ordered=item.get('ordered', False),
                     color=item_color(item, '#000000', theme_colors))
        elif kind == 'table':
            add_table(slide, x, y, w, h, item.get('data', {}), norm_family(item.get('ff'), default_font),
                      item_font_size(item, 12), rtl=item.get('direction') != 'ltr', theme_colors=theme_colors)
        elif kind in ('figure', 'image'):
            figure = item if kind == 'figure' else {'kind': 'image', 'html': '<img src="%s" alt="">' % item.get('src', '')}
            add_figure(slide, x, y, w, h, figure, enrich, base_dir, theme_colors=theme_colors, align=item.get('align', 'center'))
        elif kind == 'line':
            add_line(slide, x, y + max(0, h - 1) / 2, w, h, resolve_color(item.get('color'), theme_colors or {}, '#444444'), max(1, h))
        elif kind == 'html':
            add_precise_text(slide, item, item.get('html', ''), default_font, 14, theme_colors, item.get('direction') != 'ltr')

    logo = slide_data.get('logo') or {}
    if logo.get('src') and logo.get('box'):
        x, y, w, h = item_box(logo, (SLIDE_WIDTH_PX - 120, 20, 100, 30))
        add_figure(slide, x, y, w, h, {'kind': 'logo', 'html': '<img src="%s" alt="">' % logo['src']}, enrich, base_dir, theme_colors=theme_colors)
    if slide_data.get('notes'):
        try:
            slide.notes_slide.notes_text_frame.text = slide_data['notes']
        except Exception:
            pass


def render_slide(slide, slide_data, enrich, base_dir, fonts, theme_colors=None):
    font_families = [f['family'] for f in fonts]
    default_font = font_families[0] if font_families else 'Cairo'
    tc = theme_colors or {}

    # New exports carry browser-measured boxes. This is the native, fidelity
    # path; the remainder is retained only for old saved export plans.
    if slide_data.get('h1Style') or any(item.get('box') for item in slide_data.get('content', [])):
        render_precise_slide(slide, slide_data, enrich, base_dir, default_font, tc)
        return

    y = MARGIN_TOP_PX

    # Title
    h1_font = norm_family(slide_data.get('h1Ff'), default_font)
    if slide_data.get('h1'):
        add_text_box(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, 80,
                     slide_data['h1'], h1_font, float(slide_data.get('h1Fs') or 28), rtl=True,
                     color=color_to_rgb(resolve_color(tc.get('purple', '#413258'), tc, '#413258'), '#413258'),
                     theme_colors=tc)
        y += 85

    # Subtitle
    h2_font = norm_family(slide_data.get('h2Ff'), default_font)
    if slide_data.get('h2'):
        add_text_box(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, 50,
                     slide_data['h2'], h2_font, float(slide_data.get('h2Fs') or 20), rtl=True,
                     color=color_to_rgb(resolve_color(tc.get('cyan', '#1AD9C7'), tc, '#1AD9C7'), '#1AD9C7'),
                     theme_colors=tc)
        y += 55

    # Reserve footer space
    content_bottom = SLIDE_HEIGHT_PX - MARGIN_BOTTOM_PX - 90

    content_items = slide_data.get('content', [])
    for item in content_items:
        item_type = item.get('type')
        if item_type == 'paragraph':
            # Inline paragraph in the flowing body block
            pass
        elif item_type == 'list':
            pass
        elif item_type == 'table':
            table_data = item.get('data', {})
            num_rows = 1 + len(table_data.get('rows', [])) if table_data.get('headers') else len(table_data.get('rows', []))
            num_cols = len(table_data.get('headers', [])) or (len(table_data.get('rows', [])[0]) if table_data.get('rows') else 0)
            if num_rows and num_cols:
                table_height = max(70, num_rows * 30 + 10)
                if y + table_height > content_bottom:
                    table_height = content_bottom - y
                if table_height > 10:
                    add_table(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, table_height,
                              table_data, norm_family(item.get('ff'), default_font),
                              item_font_size(item, 12), rtl=True, theme_colors=tc)
                    y += table_height + 10
            continue
        elif item_type == 'figure':
            fig_h = 120
            if y + fig_h > content_bottom:
                fig_h = content_bottom - y
            if fig_h > 10:
                add_figure(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, fig_h,
                           item, enrich, base_dir, theme_colors=tc,
                           align=item.get('align', 'center'))
                y += fig_h + 10
            continue
        elif item_type == 'image':
            img_h = 120
            if y + img_h > content_bottom:
                img_h = content_bottom - y
            if img_h > 10:
                fig_data = {
                    'kind': 'image',
                    'propId': item.get('src', ''),
                    'html': f'<img src="{item.get("src", "")}" alt="">'
                }
                add_figure(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, img_h,
                           fig_data, enrich, base_dir, theme_colors=tc,
                           align=item.get('align', 'center'))
                y += img_h + 10
            continue
        elif item_type == 'line':
            line_h = 6
            if y + line_h > content_bottom:
                line_h = content_bottom - y
            if line_h > 1:
                line_color = resolve_color(item.get('color', '#444444'), tc, '#444444')
                add_line(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, line_h,
                         line_color, thickness_px=3)
                y += line_h + 8
            continue
        elif item_type == 'shape':
            shape_h = 80
            if y + shape_h > content_bottom:
                shape_h = content_bottom - y
            if shape_h > 10:
                add_shape(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, shape_h, item)
                y += shape_h + 10
            continue
        elif item_type == 'quiz':
            quiz_h = 100
            if y + quiz_h > content_bottom:
                quiz_h = content_bottom - y
            if quiz_h > 10:
                add_quiz(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, quiz_h,
                         item.get('html', ''), norm_family(item.get('ff'), default_font),
                         item_font_size(item, 14), rtl=True, theme_colors=tc)
                y += quiz_h + 10
            continue
        elif item_type == 'html':
            block_h = 60
            if y + block_h > content_bottom:
                block_h = content_bottom - y
            if block_h > 10:
                add_html_block(slide, MARGIN_LEFT_PX, y, CONTENT_WIDTH_PX, block_h,
                               item.get('html', ''), norm_family(item.get('ff'), default_font),
                               item_font_size(item, 14), rtl=True, theme_colors=tc)
                y += block_h + 10
            continue

    # Build one body text frame for paragraphs + lists
    paras = []  # (html, font_size, font_family)
    for item in content_items:
        item_type = item.get('type')
        if item_type == 'paragraph':
            paras.append((item.get('html', ''), item_font_size(item, 16),
                          norm_family(item.get('ff'), default_font)))
        elif item_type == 'list':
            fs = item_font_size(item, 16)
            ff = norm_family(item.get('ff'), default_font)
            for i, item_html in enumerate(item.get('items', [])):
                prefix = f"{i+1}. " if item.get('ordered') else "• "
                paras.append((prefix + (item_html or ''), fs, ff))

    if paras:
        text_height = max(180, content_bottom - y)
        txBox = slide.shapes.add_textbox(
            px_to_emu(MARGIN_LEFT_PX), px_to_emu(y),
            px_to_emu(CONTENT_WIDTH_PX), px_to_emu(text_height)
        )
        tf = txBox.text_frame
        tf.word_wrap = True
        for idx, (html, fs, ff) in enumerate(paras):
            p = tf.paragraphs[0] if idx == 0 else tf.add_paragraph()
            p.alignment = PP_ALIGN.RIGHT
            set_rtl(p)
            apply_runs_to_paragraph(p, parse_html_runs(html), ff, fs, theme_colors=tc)

    # Footers (absolute positioning at bottom)
    footer_y = SLIDE_HEIGHT_PX - 50
    if slide_data.get('footerLeft'):
        add_text_box(slide, 60, footer_y, 350, 20,
                     slide_data['footerLeft'], default_font, 10, rtl=False,
                     color=RGBColor(0x66, 0x66, 0x66), theme_colors=tc)
    if slide_data.get('footerRight'):
        add_text_box(slide, SLIDE_WIDTH_PX - 60 - 500, footer_y, 500, 20,
                     slide_data['footerRight'], default_font, 10, rtl=True,
                     alignment=PP_ALIGN.RIGHT, color=color_to_rgb(resolve_color(tc.get('purple', '#413258'), tc, '#413258'), '#413258'),
                     theme_colors=tc)
    if slide_data.get('footerSite'):
        add_text_box(slide, 60, SLIDE_HEIGHT_PX - 25, 350, 15,
                     slide_data['footerSite'], default_font, 8, rtl=False,
                     color=RGBColor(0xB3, 0xB3, 0xB3), theme_colors=tc)

    # Logo (top-right) - render actual image if available
    if slide_data.get('logo'):
        logo_data = slide_data['logo']
        logo_src = logo_data.get('src', '') if isinstance(logo_data, dict) else ''
        if logo_src:
            try:
                if logo_src.startswith('data:'):
                    header, b64 = logo_src.split(',', 1)
                    ext = '.png'
                    if 'svg+xml' in header:
                        ext = '.svg'
                    img_bytes = base64.b64decode(b64)
                    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                        tmp.write(img_bytes)
                        tmp_path = tmp.name
                    try:
                        slide.shapes.add_picture(
                            tmp_path,
                            px_to_emu(SLIDE_WIDTH_PX - 120), px_to_emu(20),
                            px_to_emu(100), px_to_emu(30)
                        )
                    finally:
                        try:
                            os.unlink(tmp_path)
                        except Exception:
                            pass
                elif base_dir and not os.path.isabs(logo_src):
                    candidate = os.path.join(base_dir, logo_src)
                    if os.path.exists(candidate):
                        slide.shapes.add_picture(
                            candidate,
                            px_to_emu(SLIDE_WIDTH_PX - 120), px_to_emu(20),
                            px_to_emu(100), px_to_emu(30)
                        )
            except Exception:
                pass
        else:
            add_text_box(slide, SLIDE_WIDTH_PX - 120, 20, 100, 30,
                         '[LOGO]', default_font, 8, rtl=False,
                         color=RGBColor(0xAA, 0xAA, 0xAA), theme_colors=tc)

    # Speaker notes
    if slide_data.get('notes'):
        try:
            notes_slide = slide.notes_slide
            notes_slide.notes_text_frame.text = slide_data['notes']
        except Exception:
            pass


SCENE_SCHEMA_VERSION = 2
# DrawingML main namespace, for the raw lxml edits python-pptx does not wrap
# (gradient fills). python-pptx already depends on lxml.
A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def scene_rgb(value, fallback='#000000'):
    """Return RGBColor for browser-resolved rgb()/rgba()/hex colors."""
    raw = (value or fallback).strip()
    if raw in ('transparent', 'rgba(0, 0, 0, 0)'):
        return None
    if raw.startswith('#'):
        try:
            return hex_to_rgb(raw)
        except Exception:
            return hex_to_rgb(fallback)
    m = re.match(r'rgba?\(\s*([\d.]+)[,\s]+\s*([\d.]+)[,\s]+\s*([\d.]+)', raw, re.I)
    if m:
        return RGBColor(int(float(m.group(1))), int(float(m.group(2))), int(float(m.group(3))))
    return hex_to_rgb(fallback)


def scene_hex6(value, fallback='#000000'):
    """RRGGBB string for the gradient stop colors the browser resolved."""
    color = scene_rgb(value, fallback)
    if color is None:
        color = scene_rgb(fallback, fallback)
    return str(color)


def scene_set_gradient(shape, gradient):
    """Replace a shape's solid fill with a native DrawingML gradient.

    The solid fill is created first so DrawingML's strict child order puts the
    fill element in a schema-valid position; the gradient then takes its place.
    """
    stops = gradient.get('stops') or []
    if len(stops) < 2:
        return
    shape.fill.solid()
    sp_pr = shape._element.spPr
    solid = sp_pr.find('{%s}solidFill' % A_NS)
    if solid is None:
        return
    grad = sp_pr.makeelement('{%s}gradFill' % A_NS, {})
    gs_lst = etree.SubElement(grad, '{%s}gsLst' % A_NS)
    for stop in stops:
        gs = etree.SubElement(gs_lst, '{%s}gs' % A_NS)
        gs.set('pos', str(int(round(float(stop.get('pos') or 0) * 100000))))
        clr = etree.SubElement(gs, '{%s}srgbClr' % A_NS)
        clr.set('val', scene_hex6(stop.get('color')))
    lin = etree.SubElement(grad, '{%s}lin' % A_NS)
    # CSS measures 0deg pointing up and turns clockwise; DrawingML measures
    # 0 pointing right and turns clockwise, in 60000ths of a degree.
    dml_deg = (float(gradient.get('cssAngle', 180)) - 90.0) % 360.0
    lin.set('ang', str(int(round(dml_deg * 60000))))
    lin.set('scaled', '1')
    solid.addnext(grad)
    sp_pr.remove(solid)


def is_scene_transparent(value):
    return not value or value == 'transparent' or bool(re.match(r'rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?\)', str(value), re.I))


def scene_box(node):
    box = node.get('bounds') or {}
    return (float(box.get('x', 0)), float(box.get('y', 0)),
            max(0.1, float(box.get('w', 1))), max(0.1, float(box.get('h', 1))))


def scene_set_fill(shape, raw):
    if is_scene_transparent(raw):
        shape.fill.background()
        return
    shape.fill.solid()
    shape.fill.fore_color.rgb = scene_rgb(raw, '#FFFFFF')


def scene_remove_text_body(shape):
    """Keep decorative shapes editable without emitting an empty text paragraph.

    python-pptx gives every AutoShape a p:txBody/a:p by default.  For a slide
    background, border bar, or divider that is not text-bearing, that becomes
    a spurious blank paragraph in the editable PPTX XML.  Remove only the text
    body; the p:sp remains a fully native, editable shape.
    """
    try:
        from pptx.oxml.ns import qn
        text_body = shape._element.find(qn('p:txBody'))
        if text_body is not None:
            shape._element.remove(text_body)
    except Exception:
        pass
    return shape


def scene_set_line(line, edge):
    width = float((edge or {}).get('width') or 0)
    style = (edge or {}).get('style') or 'none'
    if width <= 0 or style == 'none':
        line.fill.background()
        return
    line.color.rgb = scene_rgb((edge or {}).get('color'), '#000000')
    line.width = px_to_emu(width)
    # python-pptx exposes the common dash values. A CSS dashed/dotted edge is
    # still a native line, rather than a flattened bitmap approximation.
    try:
        from pptx.enum.dml import MSO_LINE_DASH_STYLE
        if style == 'dashed':
            line.dash_style = MSO_LINE_DASH_STYLE.DASH
        elif style == 'dotted':
            line.dash_style = MSO_LINE_DASH_STYLE.ROUND_DOT
    except Exception:
        pass


def scene_add_shadow(shape, shadow):
    """Attach one native a:outerShdw effect to a shape, if requested."""
    if not shadow:
        return
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        from pptx.oxml.ns import qn
        import math
        x = float(shadow.get('x') or 0)
        y = float(shadow.get('y') or 0)
        blur = max(0, float(shadow.get('blur') or 0))
        distance = int(round(math.hypot(x, y) * 9525))
        angle = int(round((math.degrees(math.atan2(y, x)) % 360) * 60000))
        sp_pr = shape._element.spPr
        effect_list = sp_pr.find(qn('a:effectLst'))
        if effect_list is None:
            effect_list = OxmlElement('a:effectLst')
            sp_pr.append(effect_list)
        outer = OxmlElement('a:outerShdw')
        outer.set('blurRad', str(int(round(blur * 9525))))
        outer.set('dist', str(distance))
        outer.set('dir', str(angle))
        color = OxmlElement('a:srgbClr')
        rgb = scene_rgb(shadow.get('color'), '#000000')
        color.set('val', ''.join(f'{v:02X}' for v in rgb))
        # Browser CSS shadows on the fixture are intentionally subtle.
        alpha = OxmlElement('a:alpha')
        alpha.set('val', '25000')
        color.append(alpha)
        outer.append(color)
        effect_list.append(outer)
    except Exception:
        # The object remains editable even when an Office XML variant rejects
        # the optional shadow effect; fidelity verification will decide whether
        # that visual discrepancy is acceptable.
        return


def scene_alignment(value, direction):
    value = (value or '').lower()
    if value in ('center', 'centre'):
        return PP_ALIGN.CENTER
    if value == 'justify':
        return PP_ALIGN.JUSTIFY
    if value in ('left', 'start'):
        return PP_ALIGN.LEFT if direction != 'rtl' else PP_ALIGN.RIGHT
    if value in ('right', 'end'):
        return PP_ALIGN.RIGHT if direction != 'rtl' else PP_ALIGN.LEFT
    return PP_ALIGN.RIGHT if direction == 'rtl' else PP_ALIGN.LEFT


def scene_run_font(run, run_style, fallback_style):
    style = dict(fallback_style or {})
    style.update(run_style or {})
    # Chromium may report an alias/fallback stack rather than the exact face
    # name desktop PowerPoint resolves.  The scene extractor can carry a
    # preflight-verified Office face separately; it must win for both normal
    # text frames and browser-measured per-line textboxes.
    family = norm_family(style.get('powerPointFontFamily') or style.get('fontFamily'), 'Arial')
    run.font.name = family
    size = float(style.get('fontSize') or 16) * 0.75
    run.font.size = Pt(max(1, size))
    weight = str(style.get('fontWeight') or '400').lower()
    if style.get('powerPointFaceHasIntrinsicWeight') is True:
        # The selected Office family name is already a physical Bold,
        # Semibold, or Black face (not a variable family). Asking PowerPoint
        # to bold it again synthesizes a heavier, wider glyph than Chromium's
        # bundled @font-face bytes.
        run.font.bold = False
    else:
        try:
            run.font.bold = weight == 'bold' or float(weight) >= 600
        except Exception:
            run.font.bold = weight == 'bold'
    run.font.italic = str(style.get('fontStyle') or '').lower() in ('italic', 'oblique')
    run.font.underline = str(style.get('textDecoration') or '').lower().find('underline') >= 0
    rgb = scene_rgb(style.get('color'), '#000000')
    if rgb is not None:
        run.font.color.rgb = rgb
    # PowerPoint resolves Arabic through the complex-script (`a:cs`) face, not
    # merely the Latin face python-pptx writes for ``run.font.name``. The old
    # code put ``latin``/``ea``/``cs`` in attributes on ``a:rPr``; those are
    # not DrawingML font records and Office could silently substitute Arabic
    # glyphs. Write the three actual child elements so native Office rendering
    # uses the same preflighted family for every script.
    try:
        rpr = run._r.get_or_add_rPr()
        # DrawingML character spacing is in hundredths of a point. Browser
        # letter-spacing is captured in CSS px (96 dpi), so preserve it rather
        # than relying on PowerPoint's default glyph spacing.
        try:
            letter_spacing = float(style.get('letterSpacing') or 0)
            if letter_spacing:
                rpr.set('spc', str(int(round(letter_spacing * 0.75 * 100))))
        except (TypeError, ValueError):
            pass
        from pptx.oxml.xmlchemy import OxmlElement
        from pptx.oxml.ns import qn
        for tag in ('a:latin', 'a:ea', 'a:cs'):
            face = rpr.find(qn(tag))
            if face is None:
                face = OxmlElement(tag)
                rpr.append(face)
            face.set('typeface', family)
    except Exception:
        pass


def scene_set_bullet(paragraph, ordered=False):
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        ppr = paragraph._p.get_or_add_pPr()
        bullet = OxmlElement('a:buAutoNum' if ordered else 'a:buChar')
        if ordered:
            bullet.set('type', 'arabicPeriod')
        else:
            bullet.set('char', '•')
        ppr.append(bullet)
    except Exception:
        pass


def scene_write_runs(text_frame, runs, node_style, list_item=False, ordered=False, split_paragraphs=True):
    text_frame.clear()
    text_frame.word_wrap = True
    padding = (node_style or {}).get('padding') or {}
    text_frame.margin_left = px_to_emu(float(padding.get('left') or 0))
    text_frame.margin_right = px_to_emu(float(padding.get('right') or 0))
    text_frame.margin_top = px_to_emu(float(padding.get('top') or 0))
    text_frame.margin_bottom = px_to_emu(float(padding.get('bottom') or 0))
    vertical = (node_style or {}).get('verticalAlign') or ''
    if vertical in ('middle', 'center'):
        text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    elif vertical in ('bottom', 'text-bottom'):
        text_frame.vertical_anchor = MSO_ANCHOR.BOTTOM
    else:
        text_frame.vertical_anchor = MSO_ANCHOR.TOP
    direction = (node_style or {}).get('direction') or 'ltr'
    align = scene_alignment((node_style or {}).get('textAlign'), direction)
    paragraphs = [text_frame.paragraphs[0]]
    current = paragraphs[0]
    current.alignment = align
    if direction == 'rtl':
        set_rtl(current)
    if list_item:
        scene_set_bullet(current, ordered)
    if not runs:
        runs = [{'text': '', 'style': {}}]
    for source_run in runs:
        source_text = str(source_run.get('text') or '')
        # A browser-measured text line must remain exactly one editable
        # PowerPoint paragraph.  Any unexpected newline is layout whitespace
        # inside that line, not permission to create a reflowing second line.
        parts = source_text.split('\n') if split_paragraphs else [source_text.replace('\r', ' ').replace('\n', ' ')]
        for part_index, text in enumerate(parts):
            if part_index:
                current = text_frame.add_paragraph()
                current.alignment = align
                if direction == 'rtl':
                    set_rtl(current)
                if list_item:
                    scene_set_bullet(current, ordered)
            run = current.add_run()
            run.text = text
            scene_run_font(run, source_run.get('style') or {}, node_style)
    try:
        line_height = float((node_style or {}).get('lineHeight') or 0)
        if line_height > 0:
            for paragraph in text_frame.paragraphs:
                paragraph.line_spacing = Pt(line_height * 0.75)
    except Exception:
        pass


def scene_add_shape(slide, node, keep_text_body=False):
    x, y, w, h = scene_box(node)
    style = node.get('style') or {}
    radius = max(style.get('borderRadius') or [0])
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0 else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(shape_type, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    gradient = style.get('gradient')
    if gradient:
        scene_set_gradient(shape, gradient)
    else:
        scene_set_fill(shape, style.get('fill'))
    # PowerPoint's shape line is necessarily uniform. For unequal CSS edges,
    # leave the shape line off and emit native per-edge rectangles below;
    # otherwise a dominant right/left border would leak onto top/bottom.
    edges = (style.get('border') or {})
    signatures = {(edge.get('width'), edge.get('style'), edge.get('color')) for edge in edges.values()}
    if len(signatures) <= 1:
        dominant = max(edges.values(), key=lambda edge: float(edge.get('width') or 0), default={})
        scene_set_line(shape.line, dominant)
    else:
        shape.line.fill.background()
    shadows = style.get('shadow') or []
    if shadows:
        scene_add_shadow(shape, shadows[0])
    if not keep_text_body:
        scene_remove_text_body(shape)
    return shape


def scene_add_border_edges(slide, node):
    style = node.get('style') or {}
    edges = style.get('border') or {}
    x, y, w, h = scene_box(node)
    # A rectangle supports one uniform border. Overlay native skinny rectangles
    # when the browser resolved different colors/widths for individual sides.
    distinct = {(edge.get('width'), edge.get('style'), edge.get('color')) for edge in edges.values()}
    if len(distinct) <= 1:
        return
    positions = {
        'top': (x, y, w, lambda e: float(e.get('width') or 0)),
        'bottom': (x, y + h - float(edges.get('bottom', {}).get('width') or 0), w, lambda e: float(e.get('width') or 0)),
        'left': (x, y, lambda e: float(e.get('width') or 0), h),
        'right': (x + w - float(edges.get('right', {}).get('width') or 0), y, lambda e: float(e.get('width') or 0), h)
    }
    for side, edge in edges.items():
        if float(edge.get('width') or 0) <= 0 or edge.get('style') == 'none':
            continue
        px_x, px_y, px_w, px_h = positions[side]
        if callable(px_w): px_w = px_w(edge)
        if callable(px_h): px_h = px_h(edge)
        bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, px_to_emu(px_x), px_to_emu(px_y), px_to_emu(px_w), px_to_emu(px_h))
        scene_set_fill(bar, edge.get('color'))
        bar.line.fill.background()
        scene_remove_text_body(bar)


def scene_text_lines(node):
    """Return validated browser-measured lines, or None for legacy fallback.

    Expected shape (all coordinates are slide-relative CSS pixels):
      textLines: [{bounds:{x,y,w,h}, text?, runs?, style?, coordinateSpace?}]

    `coordinateSpace: "node"` (or `relative: true`) is also accepted for
    callers that intentionally store local line rectangles.  We reject the
    entire optional feature when one line is malformed or its assembled text
    does not describe the node text; partial line emission would silently lose
    editable content and is worse than the established whole-node fallback.
    """
    raw_lines = node.get('textLines')
    if not isinstance(raw_lines, list) or not raw_lines:
        return None
    node_style = node.get('style') or {}
    if not isinstance(node_style, dict):
        return None
    node_x, node_y, _, _ = scene_box(node)
    prepared = []

    def number(value):
        try:
            result = float(value)
            return result if result == result and abs(result) != float('inf') else None
        except (TypeError, ValueError):
            return None

    for raw_line in raw_lines:
        if not isinstance(raw_line, dict):
            return None
        box = raw_line.get('bounds') or raw_line.get('box') or raw_line.get('rect') or raw_line.get('geometry') or raw_line
        if not isinstance(box, dict):
            return None

        def first_number(*names):
            for name in names:
                if name in box:
                    value = number(box.get(name))
                    if value is not None:
                        return value
            return None

        x = first_number('x', 'left')
        y = first_number('y', 'top')
        w = first_number('w', 'width')
        h = first_number('h', 'height')
        if w is None and x is not None and number(box.get('right')) is not None:
            w = number(box.get('right')) - x
        if h is None and y is not None and number(box.get('bottom')) is not None:
            h = number(box.get('bottom')) - y
        if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
            return None
        coordinate_space = str(raw_line.get('coordinateSpace') or node.get('textLineCoordinateSpace') or '').lower()
        if raw_line.get('relative') or coordinate_space in ('node', 'local', 'element'):
            x += node_x
            y += node_y

        runs = raw_line.get('runs')
        if runs is None:
            if raw_line.get('text') is None:
                return None
            runs = [{'text': raw_line.get('text'), 'style': raw_line.get('style') or {}}]
        if not isinstance(runs, list):
            return None
        clean_runs = []
        for run in runs:
            if not isinstance(run, dict):
                return None
            text = str(run.get('text') or '').replace('\r', ' ').replace('\n', ' ')
            # Preserve a meaningful inline separator, but do not manufacture a
            # completely blank native text box for an empty measured line.
            if text:
                run_style = run.get('style') or {}
                if not isinstance(run_style, dict):
                    return None
                clean_runs.append({'text': text, 'style': run_style})
        if not ''.join(run.get('text') or '' for run in clean_runs).strip():
            continue
        line_style = raw_line.get('style') or {}
        if not isinstance(line_style, dict):
            return None
        style = dict(node_style)
        style.update(line_style)
        # Range/client-rect geometry describes the line itself, not the parent
        # element's padding box. Re-applying parent padding would offset every
        # measured textbox before PowerPoint gets a chance to render it.
        style['padding'] = {'top': 0, 'right': 0, 'bottom': 0, 'left': 0}
        style['verticalAlign'] = 'top'
        prepared.append({'bounds': (x, y, w, h), 'runs': clean_runs, 'style': style})

    if not prepared:
        return None

    expected = re.sub(r'\s+', ' ', str(node.get('text') or '')).strip()
    actual = re.sub(r'\s+', ' ', ' '.join(
        ''.join(run.get('text') or '' for run in line['runs']) for line in prepared
    )).strip()
    if expected and actual != expected:
        return None
    return prepared


def scene_add_measured_text_lines(slide, node, prepared_lines=None):
    """Emit one native, non-wrapping editable text box per browser line."""
    lines = prepared_lines if prepared_lines is not None else scene_text_lines(node)
    if not lines:
        return None
    shapes = []
    for line in lines:
        x, y, w, h = line['bounds']
        shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
        scene_write_runs(shape.text_frame, line['runs'], line['style'], split_paragraphs=False)
        # This is the key difference from whole-element fallback: PowerPoint
        # must never decide where to wrap a line Chromium already measured.
        shape.text_frame.word_wrap = False
        try:
            # `NONE` writes a noAutofit element.  Combined with wrap="none",
            # this prevents PowerPoint from deciding either a new line break or
            # a different font size for Chromium-measured line geometry.
            shape.text_frame.auto_size = MSO_AUTO_SIZE.NONE
        except Exception:
            pass
        shapes.append(shape)
    return shapes


def scene_add_text(slide, node):
    measured_lines = scene_text_lines(node)
    if measured_lines:
        return scene_add_measured_text_lines(slide, node, measured_lines)
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    scene_write_runs(shape.text_frame, node.get('runs') or [], node.get('style') or {})
    return shape


def scene_local_image(source, base_dir, scratch):
    if not source:
        raise ValueError('image source is empty')
    if source.startswith('data:'):
        try:
            header, content = source.split(',', 1)
            ext = '.png'
            if 'jpeg' in header or 'jpg' in header: ext = '.jpg'
            elif 'gif' in header: ext = '.gif'
            elif 'webp' in header: ext = '.webp'
            file_path = os.path.join(scratch, 'image-%d%s' % (len(os.listdir(scratch)), ext))
            with open(file_path, 'wb') as output:
                output.write(base64.b64decode(content))
            return file_path
        except Exception as exc:
            raise ValueError('cannot decode image data URL: %s' % exc)
    if source.startswith('file:'):
        from urllib.parse import urlparse, unquote
        parsed = urlparse(source)
        source = unquote(parsed.path)
        if os.name == 'nt' and source.startswith('/'):
            source = source[1:]
    if not os.path.isabs(source) and base_dir:
        source = os.path.join(base_dir, source)
    if not os.path.exists(source):
        raise ValueError('image file is not available: %s' % source)
    return source


def scene_add_bake(slide, node, scene, scratch):
    """Place a baked element as a picture at its exact measured bounds.

    The image is captured by the same Chromium that renders the fidelity
    reference. A missing capture is a hard error: shipping a placeholder would
    make an unrenderable element indistinguishable from a real picture.
    """
    source = (scene.get('bakes') or {}).get(node.get('id'))
    if not source:
        raise ValueError(json.dumps({'stage': 'scene', 'errors': [{
            'nodeId': node.get('id'),
            'property': 'bake',
            'reason': 'no captured image was supplied for this baked element'
        }]}, ensure_ascii=False))
    path = scene_local_image(source, '', scratch)
    x, y, w, h = scene_box(node)
    return slide.shapes.add_picture(path, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))


def scene_add_image(slide, node, base_dir, scratch):
    image = node.get('image') or {}
    path = scene_local_image(image.get('src') or '', base_dir, scratch)
    x, y, w, h = scene_box(node)
    crop = image.get('crop') or {}
    fit = crop.get('fit') or 'fill'
    if fit == 'contain' and crop.get('naturalW') and crop.get('naturalH'):
        source_ratio = float(crop['naturalW']) / float(crop['naturalH'])
        target_ratio = w / h
        if source_ratio > target_ratio:
            h2 = w / source_ratio
            y += (h - h2) / 2
            h = h2
        else:
            w2 = h * source_ratio
            x += (w - w2) / 2
            w = w2
    picture = slide.shapes.add_picture(path, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    if fit == 'cover':
        # python-pptx accepts crop fractions (0.25 == 25%), even though the
        # underlying OOXML serializes them as Office percentages.
        for attr, name in (('crop_left', 'left'), ('crop_right', 'right'), ('crop_top', 'top'), ('crop_bottom', 'bottom')):
            try:
                setattr(picture, attr, float(crop.get(name) or 0))
            except Exception:
                pass
    return picture


def scene_add_line(slide, node):
    x, y, w, h = scene_box(node)
    style = node.get('style') or {}
    edge = (style.get('border') or {}).get('top') or {}
    thickness = max(float(edge.get('width') or 0), h, 1)
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, px_to_emu(x), px_to_emu(y + (h - thickness) / 2), px_to_emu(w), px_to_emu(thickness))
    scene_set_fill(line, edge.get('color') or style.get('color') or '#000000')
    line.line.fill.background()
    scene_remove_text_body(line)
    return line


def scene_add_list(slide, node):
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_textbox(px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    list_data = node.get('list') or {}
    items = list_data.get('items') or []
    style = node.get('style') or {}
    tf = shape.text_frame
    tf.clear()
    tf.word_wrap = True
    for index, item in enumerate(items):
        paragraph = tf.paragraphs[0] if index == 0 else tf.add_paragraph()
        item_style = item.get('style') or style
        paragraph.alignment = scene_alignment(item_style.get('textAlign'), item_style.get('direction'))
        if item_style.get('direction') == 'rtl':
            set_rtl(paragraph)
        scene_set_bullet(paragraph, bool(list_data.get('ordered')))
        for run_info in item.get('runs') or [{'text': item.get('text') or '', 'style': {}}]:
            run = paragraph.add_run()
            run.text = run_info.get('text') or ''
            scene_run_font(run, run_info.get('style') or {}, item_style)
    return shape


def scene_set_cell_border(cell, side, edge):
    if float((edge or {}).get('width') or 0) <= 0 or (edge or {}).get('style') == 'none':
        return
    try:
        from pptx.oxml.xmlchemy import OxmlElement
        tc_pr = cell._tc.get_or_add_tcPr()
        line = OxmlElement('a:ln' + side)
        line.set('w', str(int(float(edge.get('width') or 1) * 9525)))
        solid = OxmlElement('a:solidFill')
        rgb = OxmlElement('a:srgbClr')
        rgb_color = scene_rgb(edge.get('color'), '#000000')
        rgb.set('val', ''.join(f'{v:02X}' for v in rgb_color))
        solid.append(rgb)
        line.append(solid)
        dash = OxmlElement('a:prstDash')
        dash.set('val', 'dash' if edge.get('style') == 'dashed' else 'solid')
        line.append(dash)
        tc_pr.append(line)
    except Exception:
        pass


def scene_add_table(slide, node):
    table_data = node.get('table') or {}
    rows = table_data.get('rows') or []
    if not rows:
        return None
    num_rows = len(rows)
    num_cols = max([sum(int(cell.get('colSpan') or 1) for cell in row.get('cells') or []) for row in rows] or [1])
    x, y, w, h = scene_box(node)
    shape = slide.shapes.add_table(num_rows, num_cols, px_to_emu(x), px_to_emu(y), px_to_emu(w), px_to_emu(h))
    table = shape.table
    widths = [0.0] * num_cols
    for row in rows:
        col = 0
        for info in row.get('cells') or []:
            span = int(info.get('colSpan') or 1)
            cell_w = float((info.get('bounds') or {}).get('w') or 0) / span
            for offset in range(span):
                if col + offset < num_cols: widths[col + offset] = max(widths[col + offset], cell_w)
            col += span
    if sum(widths) > 0:
        scale = w / sum(widths)
        for index, width in enumerate(widths): table.columns[index].width = px_to_emu(width * scale)
    for r_index, row in enumerate(rows):
        row_height = float((row.get('bounds') or {}).get('h') or 0)
        if row_height > 0: table.rows[r_index].height = px_to_emu(row_height)
        col = 0
        for info in row.get('cells') or []:
            span = int(info.get('colSpan') or 1)
            if col >= num_cols: break
            cell = table.cell(r_index, col)
            if span > 1 and col + span <= num_cols:
                cell = cell.merge(table.cell(r_index, col + span - 1))
            cell_style = info.get('style') or node.get('style') or {}
            scene_set_fill(cell, cell_style.get('fill'))
            for side, xml_side in (('top', 'T'), ('right', 'R'), ('bottom', 'B'), ('left', 'L')):
                scene_set_cell_border(cell, xml_side, (cell_style.get('border') or {}).get(side) or {})
            scene_write_runs(cell.text_frame, info.get('runs') or [{'text': info.get('text') or '', 'style': {}}], cell_style)
            col += span
    return shape


def validate_scene_graph(scene):
    if not isinstance(scene, dict) or scene.get('format') != 'lve.scene-graph':
        return [{'property': 'format', 'reason': 'a versioned lve.scene-graph is required for editable export'}]
    if scene.get('schemaVersion') != SCENE_SCHEMA_VERSION:
        return [{'property': 'schemaVersion', 'reason': 'unsupported scene graph version'}]
    # Scene v2 degrades every unmappable element to a bake picture, so
    # `node.unsupported` is advisory. Only malformed geometry — something the
    # renderer genuinely cannot place — may stop an export.
    return list(scene.get('errors') or [])


def render_scene_graph(scene, suggested_name, base_dir=''):
    errors = validate_scene_graph(scene)
    if errors:
        raise ValueError(json.dumps({'stage': 'scene', 'errors': errors}, ensure_ascii=False))
    page_size = scene.get('pageSize') or {}
    width_px = float(page_size.get('widthPx') or 950)
    height_px = float(page_size.get('heightPx') or 650)
    prs = Presentation()
    prs.slide_width = Inches(width_px / 96)
    prs.slide_height = Inches(height_px / 96)
    blank = prs.slide_layouts[6]
    scratch = tempfile.mkdtemp(prefix='lve-scene-images-')
    out_path = None
    try:
        for slide_data in scene.get('slides') or []:
            slide = prs.slides.add_slide(blank)
            nodes = list(slide_data.get('nodes') or [])
            root = next((node for node in nodes if node.get('renderAs') == 'slide'), None)
            if root:
                # Slide root is a native background/shape, not a screenshot.
                root_shape = scene_add_shape(slide, root)
                scene_add_border_edges(slide, root)
                # Canvas shadows deliberately sit outside the slide in HTML and
                # therefore do not belong in an exported slide canvas.
                try:
                    root_shape._element.spPr.remove(root_shape._element.spPr.find('{http://schemas.openxmlformats.org/drawingml/2006/main}effectLst'))
                except Exception:
                    pass
            def z_value(node):
                value = node.get('zIndex')
                try: return float(value) if value is not None else 0.0
                except Exception: return 0.0
            for node in sorted([node for node in nodes if node is not root], key=lambda node: (z_value(node), node.get('order') or 0)):
                kind = node.get('renderAs')
                if kind == 'shape':
                    scene_add_shape(slide, node); scene_add_border_edges(slide, node)
                elif kind == 'shape-text':
                    # Keep the native fill/border/shadow shape below the text
                    # lines, then use measured editable text boxes when the
                    # browser supplied reliable per-line geometry.  A regular
                    # shape text frame remains the exact legacy fallback.
                    measured_lines = scene_text_lines(node)
                    shape = scene_add_shape(slide, node, keep_text_body=not bool(measured_lines)); scene_add_border_edges(slide, node)
                    if measured_lines:
                        scene_add_measured_text_lines(slide, node, measured_lines)
                    else:
                        scene_write_runs(shape.text_frame, node.get('runs') or [], node.get('style') or {})
                elif kind == 'text':
                    scene_add_text(slide, node)
                elif kind == 'bake':
                    scene_add_bake(slide, node, scene, scratch)
                elif kind == 'image':
                    scene_add_image(slide, node, base_dir, scratch)
                elif kind == 'table':
                    scene_add_table(slide, node)
                elif kind == 'list':
                    scene_add_list(slide, node)
                elif kind == 'line':
                    scene_add_line(slide, node)
            if slide_data.get('notes'):
                try: slide.notes_slide.notes_text_frame.text = slide_data['notes']
                except Exception: pass
        fd, out_path = tempfile.mkstemp(suffix='.pptx')
        os.close(fd)
        prs.save(out_path)
        os.makedirs(os.path.dirname(os.path.abspath(suggested_name)), exist_ok=True)
        shutil.copy2(out_path, suggested_name)
        return suggested_name
    finally:
        if out_path and os.path.exists(out_path):
            try: os.unlink(out_path)
            except Exception: pass
        shutil.rmtree(scratch, ignore_errors=True)


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'JSON parse: {e}'}))
        return
    
    # Editable export has exactly one contract. The old shallow plan and the
    # screenshot path are deliberately not accepted: callers must send the
    # measured versioned scene graph or receive a structured pre-render error.
    scene_graph = payload.get('sceneGraph') or payload.get('slidePlan') or {}
    suggested_name = payload.get('suggestedName', 'lecture.pptx')
    base_dir = payload.get('baseDir', '')
    try:
        output_path = render_scene_graph(scene_graph, suggested_name, base_dir)
        print(json.dumps({'ok': True, 'path': output_path, 'count': len(scene_graph.get('slides') or [])}, ensure_ascii=False))
    except Exception as e:
        detail = str(e)
        result = {'ok': False, 'stage': 'scene-render', 'error': detail}
        try:
            parsed = json.loads(detail)
            if isinstance(parsed, dict):
                result.update(parsed)
        except Exception:
            pass
        print(json.dumps(result, ensure_ascii=False))
    return

    slide_plan = payload.get('slidePlan', {})
    enrich = payload.get('enrich')
    theme_css = payload.get('themeCss', '')
    suggested_name = payload.get('suggestedName', 'lecture.pptx')
    base_dir = payload.get('baseDir', '')

    # Match the source slide canvas instead of assuming every lecture is 950x650.
    page_size = slide_plan.get('pageSize') or {}
    global SLIDE_WIDTH_PX, SLIDE_HEIGHT_PX, SLIDE_WIDTH_IN, SLIDE_HEIGHT_IN, CONTENT_WIDTH_PX, CONTENT_HEIGHT_PX
    try:
        SLIDE_WIDTH_PX = max(1, float(page_size.get('widthPx', SLIDE_WIDTH_PX)))
        SLIDE_HEIGHT_PX = max(1, float(page_size.get('heightPx', SLIDE_HEIGHT_PX)))
        SLIDE_WIDTH_IN = SLIDE_WIDTH_PX / 96
        SLIDE_HEIGHT_IN = SLIDE_HEIGHT_PX / 96
        CONTENT_WIDTH_PX = SLIDE_WIDTH_PX - MARGIN_LEFT_PX - MARGIN_RIGHT_PX
        CONTENT_HEIGHT_PX = SLIDE_HEIGHT_PX - MARGIN_TOP_PX - MARGIN_BOTTOM_PX
    except (TypeError, ValueError):
        pass
    
    # Extract fonts and colors from theme CSS
    fonts = extract_fonts_from_theme(theme_css)
    theme_colors = extract_theme_colors(theme_css)
    
    # Create presentation
    prs = Presentation()
    prs.slide_width = Inches(SLIDE_WIDTH_IN)
    prs.slide_height = Inches(SLIDE_HEIGHT_IN)
    
    blank_layout = prs.slide_layouts[6]  # blank
    
    slides_data = slide_plan.get('slides', [])
    for slide_data in slides_data:
        slide = prs.slides.add_slide(blank_layout)
        render_slide(slide, slide_data, enrich, base_dir, fonts, theme_colors=theme_colors)
    
    # Save to temp
    fd, out_path = tempfile.mkstemp(suffix='.pptx')
    os.close(fd)
    prs.save(out_path)
    
    # Post-process: embed fonts
    if fonts:
        try:
            embed_fonts(out_path, fonts)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': f'Font embed: {e}'}))
            return
    
    # Move to final location
    os.makedirs(os.path.dirname(os.path.abspath(suggested_name)), exist_ok=True)
    # Use copy + remove for cross-device moves
    shutil.copy2(out_path, suggested_name)
    os.unlink(out_path)
    
    print(json.dumps({'ok': True, 'path': suggested_name}))


if __name__ == '__main__':
    main()
