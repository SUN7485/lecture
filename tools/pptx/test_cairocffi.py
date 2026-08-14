import os, shutil, tempfile

# First, set up the DLL bridge before any cairo imports
import cairo as pyc
cairo_pkg_dir = pyc.__path__[0]
pyd = os.path.join(cairo_pkg_dir, '_cairo.cp314-win_amd64.pyd')
dll = os.path.join(cairo_pkg_dir, 'libcairo-2.dll')
if not os.path.exists(dll):
    shutil.copy2(pyd, dll)

# Tell cairocffi where to find the native DLL
os.environ['CAIROCFFI_DLL_DIRECTORIES'] = cairo_pkg_dir

try:
    import cairosvg
    print('cairosvg version:', cairosvg.__version__)
    # Test: render a tiny SVG
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>'
    tmp_svg = os.path.join(tempfile.gettempdir(), 'test_cairo.svg')
    tmp_png = os.path.join(tempfile.gettempdir(), 'test_cairo.png')
    with open(tmp_svg, 'w') as f:
        f.write(svg)
    cairosvg.svg2png(url=tmp_svg, write_to=tmp_png, output_width=100, output_height=50)
    print('PNG exists:', os.path.exists(tmp_png), 'size:', os.path.getsize(tmp_png))
    print('SUCCESS: cairosvg works!')
except Exception as e:
    print('FAILED:', type(e).__name__, str(e)[:300])
