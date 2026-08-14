import re, os, sys, tempfile, traceback, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cairosvg
from pathlib import Path

s = open(r'D:\lectuer\2.html', encoding='utf-8').read()
svg = re.findall(r'(<svg.*?</svg>)', s, re.S)[0]
tmp = tempfile.NamedTemporaryFile(suffix='.svg', delete=False, mode='w', encoding='utf-8')
tmp.write(svg); tmp.close()
out = tmp.name + '.png'
for label, url in [('tmpname', tmp.name), ('uri', Path(tmp.name).as_uri()), ('data-url', 'data:image/svg+xml;base64,' + base64.b64encode(svg.encode('utf-8')).decode())]:
    try:
        if os.path.exists(out): os.unlink(out)
        cairosvg.svg2png(url=url, write_to=out, output_width=830, output_height=110)
        print(label, 'OK', os.path.getsize(out) if os.path.exists(out) else 0)
    except Exception as e:
        print(label, 'FAIL', repr(e))