import os
from PIL import Image, ImageDraw

SRC = r"C:\Users\SunmanXU\AppData\Local\Temp\musicsmx-logo\MusicSMX-icon-1024.png"
ROOT = r"E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\android\app\src\main\res"
WWW = r"E:\AI相关\工作目录-个人\20261122-MusicSMX-Android\www\native"

BG = (26, 29, 38, 255)   # #1A1D26

logo = Image.open(SRC).convert("RGBA")
w, h = logo.size
px = logo.load()

# 1) 抠出橙色 S：背景是深蓝渐变（B > R），S 是橙（R >> B），按 (R-B) 算软 alpha
s_img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
sp = s_img.load()
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        d = r - b
        alpha = 0 if d <= 40 else min(255, int((d - 40) * 1.7))
        if alpha > 0:
            sp[x, y] = (r, g, b, alpha)

bbox = s_img.getbbox()
print("S bbox", bbox)
s_img = s_img.crop(bbox)
SW, SH = s_img.size
print("S size", SW, SH)


def rounded_tile(size, s_ratio, radius_ratio=0.23, border=True):
    """深底圆角牌 + 居中 S"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    # S
    sh = int(size * s_ratio)
    sw = max(1, int(sh * SW / SH))
    s = s_img.resize((sw, sh), Image.LANCZOS)
    img.paste(s, ((size - sw) // 2, (size - sh) // 2), s)
    if border:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, outline=(255, 255, 255, 70), width=max(1, size // 128))
    return img


def circle_tile(size, s_ratio):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    img.paste(Image.new("RGBA", (size, size), BG), (0, 0), mask)
    sh = int(size * s_ratio)
    sw = max(1, int(sh * SW / SH))
    s = s_img.resize((sw, sh), Image.LANCZOS)
    img.paste(s, ((size - sw) // 2, (size - sh) // 2), s)
    return img


def fg_layer(size, s_ratio):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh = int(size * s_ratio)
    sw = max(1, int(sh * SW / SH))
    s = s_img.resize((sw, sh), Image.LANCZOS)
    img.paste(s, ((size - sw) // 2, (size - sh) // 2), s)
    return img


dens = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96, "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
fg = {"mipmap-mdpi": 108, "mipmap-hdpi": 162, "mipmap-xhdpi": 243, "mipmap-xxhdpi": 324, "mipmap-xxxhdpi": 432}

for d, sz in dens.items():
    rounded_tile(sz, 0.46).save(os.path.join(ROOT, d, "ic_launcher_v20.png"))
    circle_tile(sz, 0.44).save(os.path.join(ROOT, d, "ic_launcher_v20_round.png"))
    print("icon", d, sz)

for d, sz in fg.items():
    fg_layer(sz, 0.40).save(os.path.join(ROOT, d, "ic_launcher_foreground_v20.png"))
    print("fg", d, sz)

# 启动图：深底 + 居中 S（无牌）
splashes = [
    ("drawable", 480, 320), ("drawable-land-mdpi", 480, 320), ("drawable-land-hdpi", 800, 480),
    ("drawable-land-xhdpi", 1280, 720), ("drawable-land-xxhdpi", 1600, 960), ("drawable-land-xxxhdpi", 1920, 1280),
    ("drawable-port-mdpi", 320, 480), ("drawable-port-hdpi", 480, 800), ("drawable-port-xhdpi", 720, 1280),
    ("drawable-port-xxhdpi", 960, 1600), ("drawable-port-xxxhdpi", 1280, 1920),
]
for d, ww, hh in splashes:
    img = Image.new("RGBA", (ww, hh), BG)
    tile = rounded_tile(int(min(ww, hh) * 0.30), 0.46)
    t = tile.size[0]
    img.paste(tile, ((ww - t) // 2, (hh - t) // 2), tile)
    img.save(os.path.join(ROOT, d, "splash.png"))
    print("splash", d, ww, hh)

# 应用内左上角 logo（26px 显示，给 256 足够）
rounded_tile(256, 0.46).save(os.path.join(WWW, "logo.png"))
print("DONE")
