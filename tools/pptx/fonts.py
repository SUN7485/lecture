import re
import base64
import zipfile
from pathlib import Path

def extract_fonts_from_theme(theme_css):
    """Extract @font-face rules with base64 data URLs from theme CSS."""
    fonts = []
    if not theme_css:
        return fonts
    pattern = re.compile(
        r"@font-face\s*\{[^}]*font-family:\s*'([^']+)'[^}]*font-weight:\s*(\d+)[^}]*src:\s*url\(data:([^;]+);base64,([^)]+)\)[^}]*\}",
        re.IGNORECASE | re.DOTALL
    )
    for m in pattern.finditer(theme_css):
        family = m.group(1)
        weight = int(m.group(2))
        mime = m.group(3)
        b64 = m.group(4)
        try:
            fonts.append({
                'family': family,
                'weight': weight,
                'mime': mime,
                'bytes': base64.b64decode(b64)
            })
        except Exception:
            pass
    return fonts


def mime_to_ext(mime):
    mime = (mime or '').lower()
    if 'opentype' in mime or 'otf' in mime:
        return '.otf'
    if 'woff2' in mime:
        return '.woff2'
    if 'woff' in mime:
        return '.woff'
    if 'truetype' in mime or 'ttf' in mime:
        return '.ttf'
    return '.bin'


def mime_to_content_type(mime, ext):
    ext = (ext or '').lower()
    mime = (mime or '').lower()
    if 'opentype' in mime or ext == '.otf':
        return 'application/vnd.ms-opentype'
    if ext == '.woff2':
        return 'font/woff2'
    if ext == '.woff':
        return 'font/woff'
    if ext == '.ttf':
        return 'font/ttf'
    return 'application/octet-stream'


def embed_fonts(pptx_path, fonts):
    if not fonts:
        return
    
    with zipfile.ZipFile(pptx_path, 'r') as zin:
        # Read existing XML files
        content_types_xml = zin.read('[Content_Types].xml').decode('utf-8') if '[Content_Types].xml' in zin.namelist() else ''
        pres_rels_xml = zin.read('ppt/_rels/presentation.xml.rels').decode('utf-8') if 'ppt/_rels/presentation.xml.rels' in zin.namelist() else ''
        pres_xml = zin.read('ppt/presentation.xml').decode('utf-8') if 'ppt/presentation.xml' in zin.namelist() else ''
        
        # Parse for next rId
        rId_nums = [int(x) for x in re.findall(r'Id="rId(\d+)"', pres_rels_xml)]
        next_rId = max(rId_nums, default=0) + 1
        
        # Prepare new entries
        font_entries = []
        rel_entries = []
        new_font_files = {}
        font_map = {}
        
        for font in fonts:
            ext = mime_to_ext(font['mime'])
            ct = mime_to_content_type(font['mime'], ext)
            font_name = f"font{next_rId}{ext}"
            rId = f"rId{next_rId}"
            
            font_entries.append(
                f'<Override PartName="/ppt/fonts/{font_name}" ContentType="{ct}"/>'
            )
            rel_entries.append(
                f'<Relationship Id="{rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="../fonts/{font_name}"/>'
            )
            new_font_files[f"ppt/fonts/{font_name}"] = font['bytes']
            font_map[font['family']] = rId
            next_rId += 1
        
        # Update [Content_Types].xml
        if '</Types>' in content_types_xml:
            content_types_xml = content_types_xml.replace('</Types>', '\n'.join(font_entries) + '\n</Types>')
        
        # Update ppt/_rels/presentation.xml.rels
        if '</Relationships>' in pres_rels_xml:
            pres_rels_xml = pres_rels_xml.replace('</Relationships>', '\n'.join(rel_entries) + '\n</Relationships>')
        
        # Update each slide's rels
        slide_rels_updates = {}
        for name in zin.namelist():
            if name.startswith('ppt/slides/_rels/slide') and name.endswith('.xml.rels'):
                rels_data = zin.read(name).decode('utf-8')
                slide_rIds = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels_data)]
                slide_next = max(slide_rIds, default=0) + 1
                slide_rel_entries = []
                for font in fonts:
                    ext = mime_to_ext(font['mime'])
                    font_name = f"font{font_map[font['family']].replace('rId', '')}{ext}"
                    s_rId = f"rId{slide_next}"
                    slide_rel_entries.append(
                        f'<Relationship Id="{s_rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="../fonts/{font_name}"/>'
                    )
                    slide_next += 1
                if '</Relationships>' in rels_data:
                    rels_data = rels_data.replace('</Relationships>', '\n'.join(slide_rel_entries) + '\n</Relationships>')
                slide_rels_updates[name] = rels_data
        
        # Update presentation.xml with embeddedFontLst
        if '<p:embeddedFontLst' not in pres_xml:
            font_refs = []
            for i, font in enumerate(fonts):
                rId = font_map.get(font['family'], f"rId{i+1}")
                font_refs.append(
                    f'<p:embeddedFont id="{i+1}" typeface="{font["family"]}">'
                    f'<a:fontRef idx="0"><a:schemeClr val="tx1"/></a:fontRef>'
                    f'</p:embeddedFont>'
                )
            embedded = f'<p:embeddedFontLst>{"".join(font_refs)}</p:embeddedFontLst>'
            if '</p:presentation>' in pres_xml:
                pres_xml = pres_xml.replace('</p:presentation>', embedded + '</p:presentation>')
        
        # Write all files to new zip
        with zipfile.ZipFile(pptx_path + '.tmp', 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item in slide_rels_updates:
                    zout.writestr(item, slide_rels_updates[item])
                elif item == '[Content_Types].xml':
                    zout.writestr(item, content_types_xml)
                elif item == 'ppt/_rels/presentation.xml.rels':
                    zout.writestr(item, pres_rels_xml)
                elif item == 'ppt/presentation.xml':
                    zout.writestr(item, pres_xml)
                else:
                    zout.writestr(item, zin.read(item))
            for fname, data in new_font_files.items():
                zout.writestr(fname, data)
    
    # Replace original with modified
    Path(pptx_path + '.tmp').replace(pptx_path)