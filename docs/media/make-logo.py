"""Regenerates the AIDA logo files in this folder.

Text is outlined to SVG paths so the logo renders the same on GitHub, where SVG images can't load
web fonts. Fonts (both SIL OFL): League Gothic and Outfit, from github.com/google/fonts. Instance
the variable fonts first:

    pip install fonttools
    fonttools varLib.instancer "LeagueGothic[wdth].ttf" wdth=100 -o LeagueGothic-Regular.ttf
    fonttools varLib.instancer "Outfit[wght].ttf" wght=700 -o Outfit-Bold.ttf
    python make-logo.py <fonts-dir>

The PNGs (aida-mark.png at 256 px, aida-social.png at 1280x640) are screenshots of the SVGs.
"""
import os
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = os.path.dirname(os.path.abspath(__file__))
DISPLAY = os.path.join(FONTS, "LeagueGothic-Regular.ttf")
TEXT = os.path.join(FONTS, "Outfit-Bold.ttf")

INK = "#0D1210"
GREEN = "#10B981"


def text_path(fontfile, text, size, x0, baseline, tracking=0.0):
    font = TTFont(fontfile)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    x = x0
    paths = []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        paths.append(pen.getCommands())
        x += glyphs[name].width * scale + tracking * size
    return " ".join(paths), x - tracking * size


def mark(x, y, h, fill=GREEN):
    """The "last checked" pill with a tick, h tall."""
    w = h * 1.55
    tick = (f"M{x + w * 0.30:.1f} {y + h * 0.53:.1f} L{x + w * 0.45:.1f} {y + h * 0.70:.1f} "
            f"L{x + w * 0.72:.1f} {y + h * 0.33:.1f}")
    return (f'<rect x="{x}" y="{y}" width="{w:.1f}" height="{h}" rx="{h / 2}" fill="{fill}"/>'
            f'<path d="{tick}" fill="none" stroke="#fff" stroke-width="{h * 0.13:.1f}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'), w


def write(name, svg):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(svg)


def logo(fg, sub, name):
    height = 120
    pill, pill_w = mark(0, (height - 56) / 2 - 4, 56)
    word, word_end = text_path(DISPLAY, "AIDA", 112, pill_w + 22, 100, 0.02)
    line1, end1 = text_path(TEXT, "Agent-driven Instruction", 20, word_end + 28, 58)
    line2, end2 = text_path(TEXT, "and Documentation Automation", 20, word_end + 28, 86)
    width = max(end1, end2) + 4
    write(name, f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height}" '
                f'width="{width:.0f}" height="{height}" role="img" '
                f'aria-label="AIDA: Agent-driven Instruction and Documentation Automation">'
                f'{pill}<path d="{word}" fill="{fg}"/><path d="{line1} {line2}" fill="{sub}"/></svg>')


logo(INK, "#5B6660", "aida-logo.svg")
logo("#F4F5F2", "#A3ADA8", "aida-logo-dark.svg")

pill, _ = mark(20.6, 36, 56)
write("aida-mark.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" '
                       f'height="128" role="img" aria-label="AIDA">{pill}</svg>')

# Social preview, 1280x640: the logo at 1.6x over the headline.
light = open(os.path.join(OUT, "aida-logo.svg")).read()
logo_w = float(re.search(r'viewBox="0 0 ([\d.]+)', light).group(1))
inner = light[light.index(">") + 1:light.rindex("</svg>")]
_, w1 = text_path(TEXT, "Turn your app into user guides", 52, 0, 0)
_, w2 = text_path(TEXT, "and narrated tutorials.", 52, 0, 0)
head1, _ = text_path(TEXT, "Turn your app into user guides", 52, (1280 - w1) / 2, 420)
head2, _ = text_path(TEXT, "and narrated tutorials.", 52, (1280 - w2) / 2, 486)
write("aida-social.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">'
                         f'<rect width="1280" height="640" fill="#F4F5F2"/>'
                         f'<g transform="translate({(1280 - logo_w * 1.6) / 2:.1f} 150) scale(1.6)">{inner}</g>'
                         f'<path d="{head1} {head2}" fill="{INK}"/>'
                         f'<rect x="0" y="616" width="1280" height="24" fill="{GREEN}"/></svg>')
