#!/usr/bin/env python3
"""生成 reunote 的 macOS 应用图标（无外部依赖，仅需 Pillow）。"""

import math
import io
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")
OUT = os.path.normpath(OUT)
SS = 4  # 超采样倍数
SIZE = 1024


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def squircle_mask(size, radius_ratio=0.2237, n=5.0):
    """Big Sur 风格连续圆角（超椭圆）遮罩。"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    half = size / 2.0
    r = size * radius_ratio
    # 超椭圆：|x/a|^n + |y/a|^n = 1
    pts = []
    steps = 2048
    a = half
    for i in range(steps):
        theta = 2 * math.pi * i / steps
        ct, st = math.cos(theta), math.sin(theta)
        x = a * math.copysign(abs(ct) ** (2.0 / n), ct)
        y = a * math.copysign(abs(st) ** (2.0 / n), st)
        pts.append((half + x, half + y))
    d.polygon(pts, fill=255)
    _ = r
    return m


def gradient(size, top, bottom, tilt=0.35):
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        for x in range(0, size, 1):
            t = (y + (x - size / 2) * tilt) / size
            t = max(0.0, min(1.0, t))
            px[x, y] = lerp(top, bottom, t)
    return img


def stroke_path(draw, pts, w_start, w_end, color, taper="both"):
    """沿路径画变宽笔迹，模拟毛笔提按。"""
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / max(1, n - 1)
        if taper == "both":
            env = math.sin(math.pi * t) ** 0.55
        elif taper == "end":
            env = (1 - t) ** 0.8
        else:
            env = 1.0
        w = (w_start + (w_end - w_start) * t) * env
        if w <= 0.4:
            continue
        draw.ellipse([x - w, y - w, x + w, y + w], fill=color)


def bezier(p0, p1, p2, p3, steps=900):
    out = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        out.append((x, y))
    return out


def build():
    S = SIZE * SS
    base = gradient(S, (12, 101, 119), (15, 68, 94), tilt=-0.28)

    glow = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S * 0.28, -S * 0.50, S * 1.35, S * 0.62], fill=105)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.10))
    base = Image.composite(Image.new("RGB", (S, S), (55, 161, 151)), base, glow)

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 两页笔记靠拢，中心用一笔连起来，表达 reunion + note。
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for box in [
        (S * 0.185, S * 0.255, S * 0.555, S * 0.755),
        (S * 0.445, S * 0.245, S * 0.815, S * 0.745),
    ]:
        sd.rounded_rectangle(box, radius=S * 0.055, fill=(0, 25, 35, 95))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.022))
    layer.alpha_composite(shadow, (0, int(S * 0.018)))

    left = (S * 0.185, S * 0.255, S * 0.555, S * 0.755)
    right = (S * 0.445, S * 0.245, S * 0.815, S * 0.745)
    d.rounded_rectangle(left, radius=S * 0.055, fill=(230, 247, 243, 255), outline=(174, 226, 216, 230), width=int(S * 0.008))
    d.rounded_rectangle(right, radius=S * 0.055, fill=(255, 241, 216, 255), outline=(255, 207, 139, 230), width=int(S * 0.008))

    # 页角和短横，既是笔记也让小尺寸图标有可辨识结构。
    d.polygon(
        [(S * 0.470, S * 0.255), (S * 0.555, S * 0.255), (S * 0.555, S * 0.340)],
        fill=(183, 232, 222, 255),
    )
    d.polygon(
        [(S * 0.730, S * 0.245), (S * 0.815, S * 0.245), (S * 0.815, S * 0.330)],
        fill=(255, 215, 158, 255),
    )
    for y in (0.350, 0.415, 0.660):
        d.rounded_rectangle(
            (S * 0.245, S * y, S * 0.420, S * (y + 0.018)),
            radius=S * 0.009,
            fill=(54, 143, 145, 105),
        )
    for y in (0.335, 0.660):
        d.rounded_rectangle(
            (S * 0.610, S * y, S * 0.755, S * (y + 0.018)),
            radius=S * 0.009,
            fill=(220, 125, 82, 112),
        )

    # 两条相扣的笔迹构成中间的连接符，避免依赖文字也能读出品牌意象。
    link_left = bezier(
        (S * 0.305, S * 0.545),
        (S * 0.360, S * 0.442),
        (S * 0.495, S * 0.438),
        (S * 0.590, S * 0.535),
        steps=480,
    )
    link_right = bezier(
        (S * 0.710, S * 0.535),
        (S * 0.650, S * 0.635),
        (S * 0.510, S * 0.642),
        (S * 0.415, S * 0.545),
        steps=480,
    )
    stroke_path(d, link_left, S * 0.029, S * 0.029, (20, 113, 125, 255), taper="none")
    stroke_path(d, link_right, S * 0.029, S * 0.029, (229, 112, 67, 255), taper="none")

    # 连接中心的亮点，提示两页在此相遇。
    d.ellipse(
        [S * 0.490, S * 0.512, S * 0.530, S * 0.552],
        fill=(255, 255, 249, 255),
    )

    art = Image.alpha_composite(base.convert("RGBA"), layer)

    mask = squircle_mask(S)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(art, (0, 0), mask)

    # 内描边，增加质感
    edge = mask.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(S * 0.004))
    stroke_layer = Image.new("RGBA", (S, S), (255, 255, 255, 46))
    icon = Image.composite(
        Image.alpha_composite(icon, stroke_layer), icon, edge.point(lambda v: min(255, v * 2))
    )

    # macOS 规范：图标本体只占画布约 81.6%，四周留白并带柔和投影
    inner = int(SIZE * 0.816)
    body = icon.resize((inner, inner), Image.LANCZOS)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset = (SIZE - inner) // 2

    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 110), (offset, offset + int(SIZE * 0.012)), body.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(SIZE * 0.018))
    canvas = Image.alpha_composite(canvas, shadow)

    layer2 = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    layer2.paste(body, (offset, offset), body)
    canvas = Image.alpha_composite(canvas, layer2)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    icon = build()
    icon.save(os.path.join(OUT, "icon.png"))

    for size, name in [
        (32, "32x32.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon_512.png"),
    ]:
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))

    # .icns stores PNG chunks directly. Writing the container here avoids depending on
    # iconutil, which rejects valid iconsets on some current macOS releases.
    specs = [
        ("icp4", 16),
        ("icp5", 32),
        ("icp6", 64),
        ("ic07", 128),
        ("ic08", 256),
        ("ic09", 512),
        ("ic10", 1024),
    ]
    chunks = []
    for chunk_type, size in specs:
        buffer = io.BytesIO()
        icon.resize((size, size), Image.LANCZOS).save(buffer, format="PNG")
        payload = buffer.getvalue()
        chunks.append(chunk_type.encode("ascii") + struct.pack(">I", len(payload) + 8) + payload)
    body = b"".join(chunks)
    with open(os.path.join(OUT, "icon.icns"), "wb") as out:
        out.write(b"icns" + struct.pack(">I", len(body) + 8) + body)

    os.remove(os.path.join(OUT, "icon_512.png"))
    print("图标已生成 →", OUT)


if __name__ == "__main__":
    sys.exit(main())
