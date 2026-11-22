# 從設計圖（三視圖）的像素直接做模型：輪廓交集（visual hull）＋基本形狀、顏色區塊投影成貼片、縫線一段一段投影到表面
# 由 build_model.py 匯入（在 Blender 裡執行，需要 bpy、numpy）
import bpy, bmesh, math
import numpy as np
from mathutils import Vector


def load_rgb(path):
    im = bpy.data.images.load(path)
    W, H = im.size
    A = np.array(im.pixels[:], dtype=np.float32).reshape(H, W, 4)[::-1, :, :3] * 255
    return A


def flood_bg(bgmask):
    """從圖的邊緣往內，把和邊緣相連的背景（含陰影）找出來"""
    reach = np.zeros_like(bgmask)
    reach[0, :] = bgmask[0, :]; reach[:, 0] |= bgmask[:, 0]; reach[:, -1] |= bgmask[:, -1]
    for _ in range(3000):
        n = reach.copy()
        n[1:] |= reach[:-1]; n[:-1] |= reach[1:]; n[:, 1:] |= reach[:, :-1]; n[:, :-1] |= reach[:, 1:]
        n &= bgmask
        if (n == reach).all():
            break
        reach = n
    return reach


def blur2(x, k):
    for ax in (0, 1):
        c = np.cumsum(np.pad(x, [(k + 1, k) if i == ax else (0, 0) for i in range(x.ndim)], mode='edge'), axis=ax)
        x = (np.take(c, range(2 * k + 1, c.shape[ax]), axis=ax) - np.take(c, range(0, c.shape[ax] - 2 * k - 1), axis=ax)) / (2 * k + 1)
    return x


def blur3(x, k, passes=2):
    for _ in range(passes):
        for ax in range(3):
            c = np.cumsum(np.pad(x, [(k + 1, k) if i == ax else (0, 0) for i in range(3)], mode='edge'), axis=ax)
            x = (np.take(c, range(2 * k + 1, c.shape[ax]), axis=ax) - np.take(c, range(0, c.shape[ax] - 2 * k - 1), axis=ax)) / (2 * k + 1)
    return x


def components(mask, minpx=6, maxpx=400):
    """二值圖的連通區塊（8 連通）→ 每塊的像素座標陣列"""
    H, W = mask.shape
    lab = np.zeros(mask.shape, np.int32)
    out = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        stack = [(y0, x0)]
        lab[y0, x0] = len(out) + 1
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = len(out) + 1
                        stack.append((yy, xx))
        out.append(np.array(pts))
    return [p for p in out if minpx <= len(p) <= maxpx]


def thin(img):
    """Zhang-Suen 細化：二值圖 → 一像素寬的骨架"""
    I = np.pad(img.astype(np.uint8), 1)
    changed = True
    while changed:
        changed = False
        for step in (0, 1):
            P2, P3, P4, P5 = I[:-2, 1:-1], I[:-2, 2:], I[1:-1, 2:], I[2:, 2:]
            P6, P7, P8, P9 = I[2:, 1:-1], I[2:, :-2], I[1:-1, :-2], I[:-2, :-2]
            nb = [P2, P3, P4, P5, P6, P7, P8, P9]
            B = sum(n.astype(np.int32) for n in nb)
            seq = nb + [P2]
            Acount = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.int32) for i in range(8))
            C = I[1:-1, 1:-1] == 1
            if step == 0:
                m = C & (B >= 2) & (B <= 6) & (Acount == 1) & ((P2 * P4 * P6) == 0) & ((P4 * P6 * P8) == 0)
            else:
                m = C & (B >= 2) & (B <= 6) & (Acount == 1) & ((P2 * P4 * P8) == 0) & ((P2 * P6 * P8) == 0)
            if m.any():
                I[1:-1, 1:-1][m] = 0
                changed = True
    return I[1:-1, 1:-1].astype(bool)


def trace(skel, minlen=30):
    """骨架 → 一條條折線（像素座標 (y, x) 的陣列）；分岔處拆開，短的丟掉"""
    sk = skel.copy()
    H, W = sk.shape
    def nbrs(y, x):
        out = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if (dy or dx) and 0 <= y + dy < H and 0 <= x + dx < W and sk[y + dy, x + dx]:
                    out.append((y + dy, x + dx))
        return out
    paths = []
    while True:
        ys, xs = np.nonzero(sk)
        if len(ys) == 0:
            break
        start = None
        for y, x in zip(ys, xs):                      # 先從端點開始
            if len(nbrs(y, x)) == 1:
                start = (y, x); break
        if start is None:
            start = (ys[0], xs[0])
        path = [start]; sk[start] = False
        cur = start
        while True:
            nb = nbrs(*cur)
            if not nb:
                break
            # 優先走直線方向
            if len(path) >= 2:
                dy0, dx0 = cur[0] - path[-2][0], cur[1] - path[-2][1]
                nb.sort(key=lambda p: -((p[0] - cur[0]) * dy0 + (p[1] - cur[1]) * dx0))
            cur = nb[0]; path.append(cur); sk[cur] = False
        if len(path) >= minlen:
            paths.append(np.array(path, float))
    return paths
