import re, sys

html = open('D:/lectuer/2.html', encoding='utf-8').read()

slides = re.findall(r'<div class="slide"[^>]*>(.*?)(?=<div class="slide"|<footer|<div class="page-footer|<div class="progress|$)', html, re.DOTALL)
print(f'Total slides (divs): {len(slides)}')

svgs = re.findall(r'<svg[^>]*>.*?</svg>|<svg[^>]*/>', html, re.DOTALL)
print(f'Total SVGs: {len(svgs)}')
for i, svg in enumerate(svgs):
    preview = svg[:200].replace('\n', ' ')
    print(f'  SVG {i+1}: {preview}...')
    idx = html.find(svg)
    before = html[:idx]
    slide_count = len(re.findall(r'<div class="slide"', before))
    print(f'    on slide ~{slide_count+1}')

figs = re.findall(r'<figure[^>]*class="ve-slot[^"]*"[^>]*>.*?</figure>', html, re.DOTALL)
print(f'\nTotal figure.ve-slot: {len(figs)}')
for i, f in enumerate(figs):
    idx = html.find(f)
    before = html[:idx]
    slide_count = len(re.findall(r'<div class="slide"', before))
    preview = f[:150].replace('\n', ' ')
    print(f'  FIG {i+1} on slide ~{slide_count+1}: {preview}...')

# Check for embedded image data URLs
imgs = re.findall(r'<img[^>]+src="data:image[^"]*"', html)
print(f'\nTotal inline data:image <img>: {len(imgs)}')
