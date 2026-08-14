# Inspect a produced .pptx and assert the things verify-pptx.js claims:
# slide count, slide 7 & 8 carry real pictures (not text placeholders),
# and per-element font sizes differ where CSS says they should.
import sys
from pptx import Presentation
from pptx.util import Emu

path = sys.argv[1]
prs = Presentation(path)
all_slides = list(prs.slides)
print('SLIDE COUNT', len(all_slides))

def shape_info(slide):
    out = []
    for sh in slide.shapes:
        t = sh.shape_type
        kind = 'PIC' if 'PICTURE' in str(t) else ('TABLE' if 'TABLE' in str(t) else 'TEXT')
        txt = ''
        if sh.has_text_frame:
            txt = sh.text_frame.text[:40].replace('\n', ' ')
        out.append({'kind': kind, 'name': sh.name, 'w': int((sh.width or 0) / 9525),
                    'h': int((sh.height or 0) / 9525), 'txt': txt})
    return out

for idx in [0, 1, 6, 7]:
    slide = all_slides[idx]
    infos = shape_info(slide)
    pics = [i for i in infos if i['kind'] == 'PIC']
    texty = [i for i in infos if i['kind'] == 'TEXT' and i['txt']]
    print(f'\n--- SLIDE {idx+1} ---')
    print(' shapes:', len(infos), '| pictures:', len(pics))
    for p in pics:
        print('   PIC', p['w'], 'x', p['h'])
    # Any placeholder-looking box that is NOT a picture on the svg slides is a fail.
    if idx + 1 in (7, 8):
        nonpic_text = [i for i in infos if i['kind'] == 'TEXT' and i['txt'] and '[SVG' in i['txt']]
        print('   svg-placeholder TEXT (should be 0):', len(nonpic_text))
        if len(pics) == 0:
            print('   FAIL: svg slide has no picture shape')
        else:
            print('   PASS: svg slide rasterised to picture')

print('\n--- BODY PARAGRAPH FONT CHECK (slide 5 container) ---')
s5 = all_slides[4]
sizes = set()
for sh in s5.shapes:
    if sh.has_text_frame and sh.text_frame:
        for p in sh.text_frame.paragraphs:
            for r in p.runs:
                if r.font.size:
                    sizes.add(round(r.font.size.pt, 1))
print('  slide-5 run font sizes (pt):', sorted(sizes))