import re, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from renderer import convert_svg_to_png, png_size

s = open(r'D:\lectuer\2.html', encoding='utf-8').read()
svgs = re.findall(r'(<svg.*?</svg>)', s, re.S)
print('svg count:', len(svgs))
for i, svg in enumerate(svgs):
    tmp = tempfile.NamedTemporaryFile(suffix='.svg', delete=False, mode='w', encoding='utf-8')
    tmp.write(svg)
    tmp.close()
    out = tmp.name + '.png'
    ok, w, h = convert_svg_to_png(tmp.name, out)
    size = png_size(out) if os.path.exists(out) else None
    print('svg', i, 'convert ok=', ok, 'out=', w, 'x', h, 'png_size=', size)
    os.unlink(tmp.name)
    if os.path.exists(out):
        os.unlink(out)