"""把 Codex 生成的 desktop-pet 精灵表(4 列 x 2 行、透明背景)拆成单帧,放进 pet-frames/raw/,
再由 prepare_frames.py 统一处理。可以重复运行,会覆盖 raw/ 里同名动作的旧帧。

用法:
    python tools/import_desktop_pet.py [素材目录]
    python tools/prepare_frames.py
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pet-frames" / "raw"
DEFAULT_SRC = Path(r"C:\Users\93785\Documents\Codex\2026-08-28\24-github-claude-code-x20-2\outputs\desktop-pet")

# 动作名 -> (精灵表文件, 用到的格子序号(0 起,先行后列))
# 各张精灵表的内容:
#   crawl-sheet      8 帧多足爬行
#   social-sheet     上排 4 帧摸头反应,下排 4 帧招手
#   rest-fixed-sheet 上排 2 帧被提起 + 2 帧落地缓冲,下排 4 帧打盹(由浅到深)
ACTIONS = {
    "walk": ("crawl-sheet.png", [0, 1, 2, 3, 4, 5, 6, 7]),
    "idle": ("crawl-sheet.png", [0]),          # 只有一张站姿,呼吸起伏由 spriteRig 用缩放实现
    "happy": ("social-sheet.png", [0, 1, 2, 3]),
    "wave": ("social-sheet.png", [4, 5, 6, 7]),
    "held": ("rest-fixed-sheet.png", [0, 1]),
    "land": ("rest-fixed-sheet.png", [2, 3]),
    "sit": ("rest-fixed-sheet.png", [4]),      # 放松伏低,静止不动
    "sleep": ("rest-fixed-sheet.png", [7]),    # 低头打盹,静止不动(两帧来回切换会看起来一抽一抽)
}
COLS, ROWS = 4, 2


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    RAW.mkdir(parents=True, exist_ok=True)
    sheets = {}
    for action, (fname, cells) in ACTIONS.items():
        for old in RAW.glob(f"{action}_*.png"):
            old.unlink()
        if fname not in sheets:
            sheets[fname] = Image.open(src / fname).convert("RGBA")
        sheet = sheets[fname]
        cw, ch = sheet.width // COLS, sheet.height // ROWS
        for n, idx in enumerate(cells, 1):
            r, c = divmod(idx, COLS)
            sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)).save(RAW / f"{action}_{n}.png")
        print(f"{action}: {len(cells)} 帧  <- {fname}")


if __name__ == "__main__":
    main()
