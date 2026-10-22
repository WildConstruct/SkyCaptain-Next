"""Wraps a render as a JPEG inside an SVG (<200 KiB) so it can be posted to Notion as text.
Usage: python3 tools/notion-svg.py <in.png> <out.svg> [max_width]"""
import base64, io, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
max_w = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
im = Image.open(src).convert('RGB')
if im.width > max_w:
    im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
for q in (72, 65, 58, 50, 42):
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=q, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
           f'width="{im.width}" height="{im.height}" viewBox="0 0 {im.width} {im.height}">'
           f'<image width="{im.width}" height="{im.height}" xlink:href="data:image/jpeg;base64,{b64}"/></svg>')
    if len(svg.encode()) < 195 * 1024:
        open(dst, 'w').write(svg)
        print(f'{dst}: {im.width}x{im.height} q{q} {len(svg)//1024} KiB')
        break
else:
    sys.exit('too large even at q40; pass a smaller max_width')
