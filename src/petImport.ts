import { invoke } from "@tauri-apps/api/core";

// 上传形象的处理流水线:抠背景 -> 按网格切帧 -> 统一缩放并脚底对齐。
// 输出的帧和内置素材(tools/prepare_frames.py)规格一致:FRAME x FRAME 的正方形,
// 角色高度 CHAR_H,脚底落在 BASELINE 这条线上,这样动画引擎才能像对待内置素材一样播放它们。
export const FRAME = 280;
const CHAR_H = 176;
const BASELINE = FRAME - 12;
const MAX_SIDE = 2048; // 上传的图太大就先缩小,免得抠图时占用大量内存

export interface ImportOptions {
  cols: number;
  rows: number;
  removeBg: boolean;
  /** 背景容差 0..100,越大抠得越狠(背景和角色颜色接近时调小) */
  tolerance: number;
  /** 原图里角色朝左时勾上,会镜像成朝右 */
  facingLeft: boolean;
}

export const defaultImportOptions = (): ImportOptions => ({
  cols: 1,
  rows: 1,
  removeBg: true,
  tolerance: 40,
  facingLeft: false,
});

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这个文件不是可识别的图片"));
    };
    img.src = url;
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// 抠背景
// ---------------------------------------------------------------------------

/** 图片已经带透明通道(有一定比例的透明像素)就不用再抠了 */
function hasTransparency(d: Uint8ClampedArray): boolean {
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) n++;
  return n / (d.length / 4) > 0.005;
}

/** 背景色 = 图片四条边上出现最多的颜色 */
function borderColor(d: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const key = (d[i] >> 5) * 64 + (d[i + 1] >> 5) * 8 + (d[i + 2] >> 5);
    const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += d[i];
    e.g += d[i + 1];
    e.b += d[i + 2];
    bins.set(key, e);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of bins.values()) if (e.n > best.n) best = e;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

function removeBackground(img: ImageData, tolerance: number): void {
  const { data: d, width: w, height: h } = img;
  const [br, bg, bb] = borderColor(d, w, h);
  const hi = 8 + tolerance * 1.1; // 距离 <= lo 完全透明,lo..hi 之间半透明(抗锯齿边缘)
  const lo = hi * 0.4;
  const dist = (i: number) => Math.hypot(d[i] - br, d[i + 1] - bg, d[i + 2] - bb);
  // 洋红/绿这类高饱和"绿幕"色角色身上不会有,整张图直接抠(连镂空处也能抠干净);
  // 白/黑/灰背景角色身上也有接近的颜色,只抠"和图片边缘连通"的那一片。
  const chroma = Math.max(br, bg, bb) - Math.min(br, bg, bb) > 100;

  const remove = new Uint8Array(w * h);
  if (chroma) {
    for (let p = 0; p < w * h; p++) if (dist(p * 4) <= hi) remove[p] = 1;
  } else {
    const stack: number[] = [];
    const push = (p: number) => {
      if (!remove[p] && dist(p * 4) <= hi) {
        remove[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * (h - 1)) push(p + w);
    }
  }

  for (let p = 0; p < w * h; p++) {
    if (!remove[p]) continue;
    const dd = dist(p * 4);
    const a = dd <= lo ? 0 : (dd - lo) / (hi - lo);
    d[p * 4 + 3] = Math.round(Math.min(d[p * 4 + 3], a * 255));
  }
}

// ---------------------------------------------------------------------------
// 切帧 / 对齐
// ---------------------------------------------------------------------------

/** 裁到不透明像素的外接矩形。整格都是透明的返回 null。 */
function tightCrop(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = src.getContext("2d", { willReadFrequently: true })!;
  const { data: d, width: w, height: h } = ctx.getImageData(0, 0, src.width, src.height);
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export interface ImportResult {
  /** PNG data URL,统一规格 */
  frames: string[];
  /** 是否做了抠背景(图片自带透明通道时不做) */
  removedBg: boolean;
}

/** 把上传的图片处理成动画帧。找不到角色时返回 frames = []。 */
export function processImage(img: HTMLImageElement, opt: ImportOptions): ImportResult {
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const work = makeCanvas(w, h);
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  wctx.drawImage(img, 0, 0, w, h);

  const data = wctx.getImageData(0, 0, w, h);
  let removedBg = false;
  if (opt.removeBg && !hasTransparency(data.data)) {
    removeBackground(data, opt.tolerance);
    wctx.putImageData(data, 0, 0);
    removedBg = true;
  }

  // 按网格切成格子,每格裁到角色的外接矩形
  const cols = Math.max(1, Math.min(8, Math.round(opt.cols)));
  const rows = Math.max(1, Math.min(8, Math.round(opt.rows)));
  const cw = Math.floor(w / cols);
  const ch = Math.floor(h / rows);
  const crops: HTMLCanvasElement[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = makeCanvas(cw, ch);
      cell.getContext("2d")!.drawImage(work, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
      const crop = tightCrop(cell);
      if (crop) crops.push(crop);
    }
  }
  if (crops.length === 0) return { frames: [], removedBg };
  const kept = crops.slice(0, 16);

  // 同一组帧用同一个缩放比例(保留帧间的大小变化),脚底对齐到统一的地面线,
  // 横向按角色的重心对齐,避免播放时左右抖动
  const maxH = Math.max(...kept.map((c) => c.height));
  const maxW = Math.max(...kept.map((c) => c.width));
  const scale = Math.min(CHAR_H / maxH, (FRAME - 16) / maxW);

  const frames = kept.map((crop) => {
    const nw = Math.max(1, Math.round(crop.width * scale));
    const nh = Math.max(1, Math.round(crop.height * scale));
    const tmp = makeCanvas(nw, nh);
    const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
    tctx.imageSmoothingQuality = "high";
    if (opt.facingLeft) {
      tctx.translate(nw, 0);
      tctx.scale(-1, 1);
    }
    tctx.drawImage(crop, 0, 0, nw, nh);

    // 重心 x
    const px = tctx.getImageData(0, 0, nw, nh).data;
    let sum = 0;
    let mass = 0;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const a = px[(y * nw + x) * 4 + 3];
        sum += a * x;
        mass += a;
      }
    }
    const cx = mass > 0 ? sum / mass : nw / 2;

    const out = makeCanvas(FRAME, FRAME);
    const octx = out.getContext("2d")!;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(tmp, Math.round(FRAME / 2 - cx), BASELINE - nh);
    return out.toDataURL("image/png");
  });
  return { frames, removedBg };
}

// ---------------------------------------------------------------------------
// 形象库(存取在 Rust 侧)
// ---------------------------------------------------------------------------
export interface PetSummary {
  id: string;
  name: string;
  frameCount: number;
  thumb: string;
}

export const petList = () => invoke<PetSummary[]>("pet_list");
export const petActiveId = () => invoke<string | null>("pet_active_id");
export const petSave = (name: string, fps: number, frames: string[]) =>
  invoke<string>("pet_save", { name, fps, frames });
export const petDelete = (id: string) => invoke<void>("pet_delete", { id });
// id 为 null = 使用内置形象
export const petSetActive = (id: string | null) => invoke<void>("pet_set_active", { id });
