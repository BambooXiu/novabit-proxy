#!/usr/bin/env python3
"""生成 DMG 安装窗口背景图（纯标准库，无第三方依赖）。

输出：
  assets/dmg-background.png     540x380  (1x)
  assets/dmg-background@2x.png 1080x760  (2x)

配色与 App 界面一致（Catppuccin Mocha）：
  #1e1e2e 主背景 / #181825 深底 / #89b4fa 强调蓝
"""

import os
import struct
import zlib

W, H = 540, 380

# ---- 颜色（RGB 0-1）----
C_TOP = (0x1E / 255, 0x1E / 255, 0x2E / 255)
C_BOT = (0x12 / 255, 0x12 / 255, 0x1B / 255)
C_ACCENT = (0x89 / 255, 0xB4 / 255, 0xFA / 255)
C_GREEN = (0xA6 / 255, 0xE3 / 255, 0xA1 / 255)

ARROW_Y = 180.0     # 与 electron-builder dmg.contents 的 y 对齐
ARROW_CX = 270.0    # 两个图标的中点 (130+410)/2

# 图标中心（用于绘制落位引导环）
ICON_L = 135.0
ICON_R = 405.0


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return (lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t))


def clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def smoothstep(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0)) if e1 != e0 else (1.0 if x >= e1 else 0.0)
    return t * t * (3.0 - 2.0 * t)


def circle_sdf(px, py, cx, cy, r):
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def rrect_sdf(px, py, cx, cy, hw, hh, rad):
    qx = abs(px - cx) - (hw - rad)
    qy = abs(py - cy) - (hh - rad)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(qx, qy), 0.0) - rad


def tri_sdf(px, py, a, b, c):
    """点到三角形的近似有符号距离（足够用于抗锯齿）。"""
    def seg(p, v, w):
        vx, vy = w[0] - v[0], w[1] - v[1]
        wx, wy = p[0] - v[0], p[1] - v[1]
        d = vx * vx + vy * vy
        t = 0.0 if d == 0 else clamp01((wx * vx + wy * vy) / d)
        dx, dy = wx - vx * t, wy - vy * t
        return (dx * dx + dy * dy) ** 0.5

    d = min(seg((px, py), a, b), seg((px, py), b, c), seg((px, py), c, a))
    # 内外判定：三个叉积同号 → 在三角形内部
    e1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1])
    e2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1])
    e3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])
    has_neg = e1 < 0 or e2 < 0 or e3 < 0
    has_pos = e1 > 0 or e2 > 0 or e3 > 0
    inside = not (has_neg and has_pos)
    return -d if inside else d


def arrow_sdf(px, py, cx, cy):
    """右向箭头：杆 + 三角头，取两者并集。"""
    shaft = rrect_sdf(px, py, cx - 16.0, cy, 22.0, 3.2, 3.2)
    head = tri_sdf(px, py, (cx + 6.0, cy - 15.0), (cx + 27.0, cy), (cx + 6.0, cy + 15.0))
    return min(shaft, head)


def render(scale):
    w, h = W * scale, H * scale
    rows = []
    for y in range(h):
        py = (y + 0.5) / scale
        row = bytearray()
        row.append(0)  # PNG filter type: none
        # 垂直渐变
        t = clamp01(py / H)
        base = mix(C_TOP, C_BOT, t * t * 0.75 + t * 0.25)
        for x in range(w):
            px = (x + 0.5) / scale
            r, g, b = base

            # --- 左上淡蓝光晕 ---
            d = circle_sdf(px, py, 60.0, 40.0, 0.0)
            glow = clamp01(1.0 - d / 420.0) ** 2.2
            r, g, b = mix((r, g, b), C_ACCENT, glow * 0.10)

            # --- 右下淡绿光晕 ---
            d2 = circle_sdf(px, py, 500.0, 360.0, 0.0)
            glow2 = clamp01(1.0 - d2 / 380.0) ** 2.4
            r, g, b = mix((r, g, b), C_GREEN, glow2 * 0.055)

            # --- 箭头底衬（柔光）---
            ad = arrow_sdf(px, py, ARROW_CX, ARROW_Y)
            soft = clamp01(1.0 - max(ad, 0.0) / 26.0) ** 2.0
            r, g, b = mix((r, g, b), C_ACCENT, soft * 0.10)

            # --- 箭头本体 ---
            a = 1.0 - smoothstep(-0.7, 0.7, ad)
            if a > 0.002:
                r, g, b = mix((r, g, b), mix(C_ACCENT, (0.90, 0.94, 1.0), 0.35), a * 0.62)

            # --- 两侧落位环（提示图标位置）---
            for icx in (ICON_L, ICON_R):
                rd = abs(circle_sdf(px, py, icx, ARROW_Y, 78.0))
                ring = 1.0 - smoothstep(0.0, 1.1, rd)
                if ring > 0.002:
                    r, g, b = mix((r, g, b), C_ACCENT, ring * 0.16)

            row += bytes((
                int(clamp01(r) * 255 + 0.5),
                int(clamp01(g) * 255 + 0.5),
                int(clamp01(b) * 255 + 0.5),
            ))
        rows.append(bytes(row))
    return w, h, b"".join(rows)


def write_png(path, w, h, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)

    for scale, name in ((1, "dmg-background.png"), (2, "dmg-background@2x.png")):
        w, h, raw = render(scale)
        out = os.path.join(assets, name)
        write_png(out, w, h, raw)
        print(f"wrote {out}  ({w}x{h}, {os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
