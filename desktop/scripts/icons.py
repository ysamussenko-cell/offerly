# Иконка Offerly: графитовый скруглённый квадрат, янтарное кольцо (буква «О»), мятная засечка прогресса. Без маскота.
# Запуск: python3 desktop/scripts/icons.py — перерисовывает desktop/src-tauri/icons/*.
from PIL import Image, ImageDraw
import os, sys

GRAPHITE, AMBER, MINT = (0x14, 0x1C, 0x2B, 255), (0xF2, 0xA5, 0x41, 255), (0x3F, 0xBF, 0x9F, 255)
OUT = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons')

def draw(size: int) -> Image.Image:
    s = 8  # суперсэмплинг против лесенок
    n = size * s
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = n * 0.22
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=r, fill=GRAPHITE)
    cx = cy = n / 2
    ro = n * 0.33
    w = n * 0.085
    # кольцо: полный янтарный круг и мятная дуга сверху справа — «пройденная часть»
    d.ellipse((cx - ro, cy - ro, cx + ro, cy + ro), outline=AMBER, width=int(w))
    d.arc((cx - ro + w / 2, cy - ro + w / 2, cx + ro - w / 2, cy + ro - w / 2), start=-90, end=0, fill=MINT, width=int(w) + 2)
    d.arc((cx - ro, cy - ro, cx + ro, cy + ro), start=-90, end=0, fill=MINT, width=int(w))
    return im.resize((size, size), Image.LANCZOS)

def main():
    os.makedirs(OUT, exist_ok=True)
    base = draw(1024)
    for name, px in (('icon.png', 512), ('128x128@2x.png', 256), ('128x128.png', 128), ('32x32.png', 32), ('tray.png', 64)):
        base.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, name))
    base.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('иконки записаны в', os.path.abspath(OUT))

if __name__ == '__main__':
    main()
