"""Build every app icon from the coin artwork in build/icon-source.png.

Run from anywhere: python scripts/make-icons.py  (needs Pillow)
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(os.path.dirname(__file__), '..', 'build', 'icon-source.png')
BG = (23, 24, 23)
# Where the coin sits in the source art (centre x, centre y, radius), in source pixels.
COIN_CX, COIN_CY, COIN_R = 623, 614, 534
SS = 2  # supersampling for the masks


def coin():
    art = Image.open(SRC).convert('RGBA')
    box = (COIN_CX - COIN_R, COIN_CY - COIN_R, COIN_CX + COIN_R, COIN_CY + COIN_R)
    disc = art.crop(box)
    n = disc.size[0]
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).ellipse([1, 1, n - 2, n - 2], fill=255)
    disc.putalpha(mask.filter(ImageFilter.GaussianBlur(1)))
    return disc

COIN = coin()


def render(size, shape='squircle', margin=0.04, coin_frac=0.86, bg=True, mode='RGBA'):
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    if bg:
        m = round(n * margin)
        mask = Image.new('L', (n, n), 0)
        md = ImageDraw.Draw(mask)
        if shape == 'squircle':
            md.rounded_rectangle([m, m, n - m - 1, n - m - 1], radius=round((n - 2 * m) * 0.225), fill=255)
        elif shape == 'circle':
            md.ellipse([m, m, n - m - 1, n - m - 1], fill=255)
        else:
            md.rectangle([0, 0, n, n], fill=255)
        img.paste(Image.new('RGBA', (n, n), BG + (255,)), (0, 0), mask)
    if coin_frac:
        d = round(n * coin_frac)
        img.alpha_composite(COIN.resize((d, d), Image.LANCZOS), ((n - d) // 2, (n - d) // 2))
    out = img.resize((size, size), Image.LANCZOS)
    return out.convert(mode) if mode != 'RGBA' else out


def save(img, rel):
    img.save(os.path.join(ROOT, rel))
    print('wrote', rel, img.size)


# Desktop: at taskbar sizes the coin alone fills the square so the heads stay visible.
def desktop(size):
    if size <= 32:
        return render(size, bg=False, coin_frac=1.0)
    return render(size)

save(desktop(1024), 'build/icon.png')
save(desktop(512), 'assets/icon.png')
save(desktop(512), 'site/img/icon.png')
ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
frames = {s: desktop(s) for s in ico_sizes}
for rel in ('build/icon.ico', 'assets/icon.ico'):
    frames[256].save(os.path.join(ROOT, rel), format='ICO', sizes=[(s, s) for s in ico_sizes],
                     append_images=[frames[s] for s in ico_sizes if s != 256])
    print('wrote', rel)

# Android. The adaptive layers sit inside a 16.7% inset, so the coin fills the visible circle.
res = 'mobile/android/app/src/main/res'
for dpi, legacy, layer in [('ldpi', 36, 81), ('mdpi', 48, 108), ('hdpi', 72, 162),
                           ('xhdpi', 96, 216), ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432)]:
    save(render(legacy, coin_frac=0.84), f'{res}/mipmap-{dpi}/ic_launcher.png')
    save(render(legacy, bg=False, coin_frac=1.0), f'{res}/mipmap-{dpi}/ic_launcher_round.png')
    save(render(layer, shape='square', coin_frac=0, mode='RGB'), f'{res}/mipmap-{dpi}/ic_launcher_background.png')
    save(render(layer, bg=False, coin_frac=0.96), f'{res}/mipmap-{dpi}/ic_launcher_foreground.png')

# Capacitor asset sources (full 108dp canvas, so the coin sits in the 66% safe zone).
save(render(1024, shape='square', coin_frac=0.64, mode='RGB'), 'mobile/assets/icon-only.png')
save(render(1024, shape='square', coin_frac=0, mode='RGB'), 'mobile/assets/icon-background.png')
save(render(1024, bg=False, coin_frac=0.64), 'mobile/assets/icon-foreground.png')
