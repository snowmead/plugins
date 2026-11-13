"""Write the kit's monospace faces, Ioskeley Mono, into kit/fonts/, which every page's stylesheet embeds.

    uv run --no-project --python 3.13 --with fonttools --with brotli python -I kit/scripts/fonts.py

Ioskeley Mono (https://github.com/ahatem/IoskeleyMono) is an open Iosevka build in the manner of Berkeley Mono, under
the SIL Open Font License 1.1 with no Reserved Font Name. It is not on Google Fonts, and host artifacts load a font
from nowhere else, so kit/build/page.ts puts each face into the stylesheet as a data URI. That stylesheet blocks the
first paint, so the faces here are cut small.

Downloads the release TAG's Web build (unhinted WOFF2, for browsers) and its LICENSE, then keeps of each face:
- the characters in UNICODES: Latin with its first extension, punctuation, arrows, math, box drawing and shapes.
  Greek, Cyrillic and the rest fall back to the next font in --mono.
- the layout features in FEATURES. The programming ligatures (calt, dlig) are left out, so a diff shows `!=` and `=>`
  as typed, as the release's NL family does.
- every name record, so each file still names its copyright and license.
To move to a newer release, change TAG to one at least 14 days old, run this, and look at the screenshots.
"""
import io, os, urllib.request, zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

TAG = 'v2.2.0'
REPO = 'https://github.com/ahatem/IoskeleyMono'
ZIP = f'{REPO}/releases/download/{TAG}/IoskeleyMono-Web.zip'
LICENSE = f'https://raw.githubusercontent.com/ahatem/IoskeleyMono/{TAG}/LICENSE'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fonts')
# The faces kit/build/page.ts declares: the weights --mono is set in (450 takes Medium), and the italic that code
# themes give comments.
FACES = ['Regular', 'Italic', 'Medium', 'SemiBold']
UNICODES = ('U+0020-007E,U+00A0-017F,U+0192,U+02C6-02DD,U+2000-206F,U+20AC,U+2122,U+2190-21FF,U+2200-22FF,'
            'U+2300-23FF,U+2500-259F,U+25A0-25FF,U+2713,U+2717,U+FFFD')
FEATURES = ['ccmp', 'locl']


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def cut(data):
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.name_IDs = ['*']
    opts.flavor = 'woff2'
    font = TTFont(io.BytesIO(data))
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue()


def main():
    os.makedirs(OUT, exist_ok=True)
    pack = zipfile.ZipFile(io.BytesIO(fetch(ZIP)))
    for face in FACES:
        name = f'IoskeleyMono-{face}.woff2'
        data = cut(pack.read(f'WOFF2/{name}'))
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
        print(f'  {name:32} {len(data) / 1024:6.1f} KB')
    with open(os.path.join(OUT, 'OFL.txt'), 'wb') as f:
        f.write(fetch(LICENSE))
    print(f'ok    Ioskeley Mono {TAG}: {len(FACES)} faces and OFL.txt in kit/fonts/')


if __name__ == '__main__':
    main()
