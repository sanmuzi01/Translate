"""把出图工具生成的动作图,处理成桌宠可以按帧播放的素材。

用法(在项目根目录):
    python tools/prepare_frames.py              # 处理 pet-frames/raw 里所有动作
    python tools/prepare_frames.py walk sit     # 只处理指定动作

输入(放进 pet-frames/raw/):
    walk.png                 一张"精灵表":同一个动作的多帧排成一张图
    walk_1.png walk_2.png …  或者一帧一个文件
    背景可以是纯色(推荐洋红 #FF00FF)或已经是透明的,脚本会自动抠掉。

可选配置 pet-frames/config.json,按动作覆盖参数,例如:
    { "walk": { "grid": [4, 2], "fps": 10, "facing": "left" } }
    grid   精灵表的 [列, 行]。默认自动按连通区域切;帧之间挨在一起切不开时再手动指定
    fps    播放帧率
    mode   loop 循环 / pingpong 来回 / once 播一遍停在最后一帧
    scale  这个动作里角色相对标准站姿的大小(坐着、睡觉一般比站着小一点)
    ref_h  原图里"标准站姿"的像素高度。设置后所有帧按同一个绝对比例缩放(不再按本动作最高的一帧归一),
           来自同一批次生成的多张图用同一个 ref_h,动作之间角色大小才一致,蹲/睡时才会自然变矮。
           配置里用 "*" 这个键可以给所有动作设置默认值
    facing 原图里角色朝哪边,left 的会自动镜像成朝右

输出:
    public/frames/<动作>/<序号>.png   统一尺寸、脚底对齐、背景透明的帧
    public/frames/manifest.json       播放清单
    pet-frames/preview/<动作>.png     预览图,先看一眼切得对不对
"""

import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pet-frames" / "raw"
OUT = ROOT / "public" / "frames"
PREVIEW = ROOT / "pet-frames" / "preview"
CONFIG = ROOT / "pet-frames" / "config.json"

# 输出帧是 FRAME x FRAME 的正方形,正好对应桌宠窗口(140x140 CSS 像素)的 2 倍分辨率。
# 角色标准站姿高 CHAR_H,脚底落在 BASELINE 这条线上 —— 所有动作的帧共用同一条地面线,
# 切换动作时角色才不会上下跳。
FRAME = 280
CHAR_H = 176
BASELINE = FRAME - 12

# 抠背景:与背景色的距离 <= lo 完全透明,lo..hi 之间按比例半透明(处理抗锯齿边缘)。
# 高饱和的"绿幕"色(洋红等)角色身上不会有,可以放宽;黑/白/灰背景角色身上也有接近的深色/浅色
# (深灰条纹、高光),必须收紧,否则会把角色自己的深色部分也抠掉。
CHROMA_T = (28, 78)
NEUTRAL_T = (8, 34)

DEFAULTS = {
    "idle": {"fps": 4, "mode": "pingpong", "scale": 1.0},
    "walk": {"fps": 9, "mode": "loop", "scale": 1.0},
    "run": {"fps": 12, "mode": "loop", "scale": 1.0},
    "sit": {"fps": 3, "mode": "pingpong", "scale": 0.86},
    "sleep": {"fps": 2, "mode": "pingpong", "scale": 0.8},
    "wave": {"fps": 8, "mode": "loop", "scale": 1.0},
    "dance": {"fps": 9, "mode": "loop", "scale": 1.0},
    "happy": {"fps": 8, "mode": "loop", "scale": 1.0},
    "look": {"fps": 4, "mode": "pingpong", "scale": 1.0},
    "held": {"fps": 6, "mode": "loop", "scale": 1.0},
    "hop": {"fps": 8, "mode": "once", "scale": 1.0},
    "land": {"fps": 8, "mode": "once", "scale": 1.0},
    "surprise": {"fps": 8, "mode": "once", "scale": 1.0},
    "stretch": {"fps": 4, "mode": "once", "scale": 1.0},
}
FALLBACK = {"fps": 8, "mode": "loop", "scale": 1.0}


# ---------------------------------------------------------------------------
# 抠背景
# ---------------------------------------------------------------------------
def remove_background(img: Image.Image) -> np.ndarray:
    arr = np.array(img.convert("RGBA"))
    # 已经带透明通道就直接用
    if (arr[..., 3] < 250).mean() > 0.005:
        return arr

    rgb = arr[..., :3].astype(np.float32)
    h, w = rgb.shape[:2]

    # 背景色 = 图片四条边上出现最多的颜色
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    q = (border // 32).astype(int)
    keys = q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2]
    vals, counts = np.unique(keys, return_counts=True)
    bg = border[keys == vals[counts.argmax()]].mean(axis=0)

    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    is_chroma = bg.max() - bg.min() > 100
    t_lo, t_hi = CHROMA_T if is_chroma else NEUTRAL_T
    candidate = dist <= t_hi

    if is_chroma:
        # 洋红/绿这类高饱和"绿幕"颜色角色身上不会有,整张图直接抠,连镂空处(比如天线之间)也能抠干净
        bg_mask = candidate
    else:
        # 黑/白/灰背景角色身上也可能有同色的地方,所以只抠"和图片边缘连通"的那一片
        labels, _ = ndi.label(candidate)
        edge_labels = set(
            np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        ) - {0}
        bg_mask = np.isin(labels, list(edge_labels))

    alpha = np.ones((h, w), np.float32)
    soft = np.clip((dist - t_lo) / (t_hi - t_lo), 0, 1)
    alpha[bg_mask] = soft[bg_mask]

    # 去毛边:边缘像素颜色里混着背景色,收缩一圈再轻微模糊,放到别的背景上就不会有一圈色边
    alpha = ndi.grey_erosion(alpha, size=3)
    alpha = ndi.gaussian_filter(alpha, 0.7)

    # 去掉零星小碎点
    labels, n = ndi.label(alpha > 0.15)
    if n > 1:
        sizes = ndi.sum(np.ones_like(alpha), labels, index=np.arange(1, n + 1))
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= 40
        alpha[~keep[labels]] = 0

    arr[..., 3] = np.round(np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return arr


# ---------------------------------------------------------------------------
# 切帧
# ---------------------------------------------------------------------------
def tight_crop(arr: np.ndarray):
    ys, xs = np.where(arr[..., 3] > 10)
    if len(xs) == 0:
        return None
    return arr[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def split_by_grid(arr: np.ndarray, cols: int, rows: int):
    h, w = arr.shape[:2]
    frames = []
    for r in range(rows):
        for c in range(cols):
            cell = arr[r * h // rows : (r + 1) * h // rows, c * w // cols : (c + 1) * w // cols]
            cropped = tight_crop(cell)
            if cropped is not None:
                frames.append(cropped)
    return frames


def split_by_components(arr: np.ndarray):
    """按连通区域自动切:把每个角色(可能由几块不相连的部分组成,如头盔和身体)合成一帧,
    再按"先行后列"排序。"""
    h, w = arr.shape[:2]
    mask = arr[..., 3] > 40
    # 先膨胀把同一个角色的零碎部分连起来,只用于分组,不影响真正的像素
    grow = max(3, int(w * 0.012))
    merged = ndi.binary_dilation(mask, structure=np.ones((3, 3)), iterations=grow)
    labels, n = ndi.label(merged)
    if n == 0:
        return []

    boxes = ndi.find_objects(labels)
    areas = np.array([ndi.sum(mask, labels, i + 1) for i in range(n)])
    keep = [i for i in range(n) if areas[i] >= areas.max() * 0.08]

    items = []
    for i in keep:
        sl = boxes[i]
        region = arr[sl].copy()
        # 只保留属于这个角色的像素,避免相邻帧的边角混进来
        region[~(labels[sl] == i + 1)] = 0
        cy = (sl[0].start + sl[0].stop) / 2
        cx = (sl[1].start + sl[1].stop) / 2
        items.append((cy, cx, sl[0].stop - sl[0].start, region))

    median_h = float(np.median([it[2] for it in items]))
    items.sort(key=lambda it: it[0])
    rows, current = [], [items[0]]
    for it in items[1:]:
        if it[0] - np.mean([x[0] for x in current]) > 0.6 * median_h:
            rows.append(current)
            current = [it]
        else:
            current.append(it)
    rows.append(current)

    frames = []
    for row in rows:
        for it in sorted(row, key=lambda x: x[1]):
            cropped = tight_crop(it[3])
            if cropped is not None:
                frames.append(cropped)
    return frames


# ---------------------------------------------------------------------------
# 统一尺寸 / 对齐
# ---------------------------------------------------------------------------
def normalize(frames, scale_k: float, flip: bool, ref_h=None):
    """同一个动作的所有帧用同一个缩放比例(保留动作里的大小变化,比如跳起来时身体拉长),
    横向按角色重心对齐(避免帧间左右抖动),纵向按脚底对齐到统一的地面线。"""
    max_h = max(f.shape[0] for f in frames)
    max_w = max(f.shape[1] for f in frames)
    base_h = ref_h or max_h
    s = min(CHAR_H * scale_k / base_h, (FRAME - 16) / max_w)
    if ref_h:
        # 绝对比例下不能因为某一帧超出画布就单独缩小,所以再保证最宽/最高的那帧放得下
        s = min(s, (FRAME - 16) / max_h)

    out = []
    for f in frames:
        im = Image.fromarray(f)
        if flip:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        nw = max(1, round(im.width * s))
        nh = max(1, round(im.height * s))
        im = im.resize((nw, nh), Image.LANCZOS)

        a = np.array(im)[..., 3].astype(np.float32)
        cx = (a.sum(axis=0) * np.arange(a.shape[1])).sum() / max(a.sum(), 1)
        x = int(round(FRAME / 2 - cx))
        y = BASELINE - nh

        canvas = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
        # 超出画布的部分先裁掉再贴(alpha_composite 不接受负偏移)
        left, top = max(0, -x), max(0, -y)
        right = min(im.width, FRAME - x)
        bottom = min(im.height, FRAME - y)
        if right > left and bottom > top:
            canvas.alpha_composite(im.crop((left, top, right, bottom)), (max(0, x), max(0, y)))
        out.append(canvas)
    return out


def make_preview(frames, path: Path):
    size = 140
    cols = min(len(frames), 8)
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * size, rows * size), (255, 255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for r in range(rows):
        for c in range(cols):
            if (r + c) % 2 == 0:
                draw.rectangle([c * size, r * size, (c + 1) * size, (r + 1) * size], fill=(238, 238, 238, 255))
    for i, fr in enumerate(frames):
        r, c = divmod(i, cols)
        sheet.alpha_composite(fr.resize((size, size), Image.LANCZOS), (c * size, r * size))
        draw.text((c * size + 4, r * size + 2), str(i + 1), fill=(200, 0, 0, 255))
        # 地面线,检查脚底是不是都对齐了
        gy = r * size + round(BASELINE * size / FRAME)
        draw.line([c * size, gy, (c + 1) * size, gy], fill=(255, 0, 0, 90), width=1)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(path)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def discover():
    """返回 {动作名: [文件路径, ...]}。<动作>.png 是精灵表,<动作>_<n>.png 是单帧。"""
    found = {}
    for p in sorted(RAW.iterdir()) if RAW.exists() else []:
        if p.suffix.lower() not in IMG_EXT:
            continue
        m = re.match(r"^(.+?)_(\d+)$", p.stem)
        name = m.group(1) if m else p.stem
        found.setdefault(name, []).append((int(m.group(2)) if m else 0, p))
    return {k: [p for _, p in sorted(v, key=lambda t: t[0])] for k, v in found.items()}


def process_action(name: str, files, user_cfg: dict):
    cfg = {**DEFAULTS.get(name, FALLBACK), **user_cfg.get("*", {}), **user_cfg.get(name, {})}
    frames = []
    for f in files:
        arr = remove_background(Image.open(f))
        if len(files) == 1:
            grid = cfg.get("grid")
            frames += split_by_grid(arr, grid[0], grid[1]) if grid else split_by_components(arr)
        else:
            # 一个文件一帧:去掉从相邻格子溢出来的零碎像素,只保留最大的那个角色
            parts = split_by_components(arr)
            if parts:
                frames.append(max(parts, key=lambda a: int((a[..., 3] > 40).sum())))

    if not frames:
        print(f"  [{name}] 没有找到角色,请检查背景色或图片内容")
        return None

    flip = cfg.get("facing", "right") == "left"
    out = normalize(frames, cfg["scale"], flip, cfg.get("ref_h"))

    target = OUT / name
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for i, fr in enumerate(out):
        fr.save(target / f"{i + 1}.png", optimize=True)
    make_preview(out, PREVIEW / f"{name}.png")
    print(f"  [{name}] {len(out)} 帧  fps={cfg['fps']}  mode={cfg['mode']}")
    return {"count": len(out), "fps": cfg["fps"], "mode": cfg["mode"]}


def main():
    user_cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    found = discover()
    wanted = sys.argv[1:] or list(found)
    if not found:
        print(f"{RAW} 里没有图片。把生成的动作图放进去再运行。")
        return

    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = {"frameSize": FRAME, "actions": {}}
    if manifest_path.exists():
        manifest["actions"] = json.loads(manifest_path.read_text(encoding="utf-8")).get("actions", {})

    print("处理中:")
    for name in wanted:
        if name not in found:
            print(f"  [{name}] raw 里没有这个动作的图,跳过")
            continue
        info = process_action(name, found[name], user_cfg)
        if info:
            manifest["actions"][name] = info

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完成。预览图在 {PREVIEW},请先看一眼切得对不对。")


if __name__ == "__main__":
    main()
