import type { PetRig, RigState } from "./petRig";

// 逐帧动画引擎:播放 tools/prepare_frames.py 处理好的帧素材(public/frames/)。
// 每一帧都是画好的姿势,所以不会有任何变形;程序只负责选哪个动作、播到第几帧、
// 左右转身、跳起时的离地高度和地面影子。

export interface ClipInfo {
  count: number;
  fps: number;
  mode: "loop" | "pingpong" | "once";
}

export interface LoadedFrames {
  clips: Record<string, { info: ClipInfo; images: HTMLImageElement[] }>;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`帧图片加载失败: ${url}`));
    img.src = url;
  });
}

// 用户上传的自定义形象(见 Rust 端 pets.rs):帧已经由前端处理成统一尺寸、脚底对齐的 PNG。
// 只有一帧时只提供 idle,走路/坐下/挥手等动作由下面的"程序动作"用同一张图做出来;
// 多帧时第一帧当 idle,整组帧当 walk 循环播放。
export interface CustomPet {
  frames: string[];
  fps: number;
}

async function loadCustom(pet: CustomPet): Promise<LoadedFrames | null> {
  try {
    const images = await Promise.all(pet.frames.map(loadImage));
    const clips: LoadedFrames["clips"] = {
      idle: { info: { count: 1, fps: 1, mode: "loop" }, images: [images[0]] },
    };
    if (images.length > 1) {
      clips.walk = { info: { count: images.length, fps: pet.fps, mode: "loop" }, images };
    }
    return { clips };
  } catch {
    return null;
  }
}

// 读取帧清单并预加载所有图片。任何一步失败(没有清单、图片缺失)都返回 null,
// 调用方会退回到"网格变形"渲染,不会因为素材问题让宠物整个不显示。
export async function loadFrames(custom?: CustomPet | null): Promise<LoadedFrames | null> {
  if (custom) return loadCustom(custom);
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}frames/manifest.json`, { cache: "no-store" });
    if (!res.ok) return null;
    // 开发服务器对不存在的文件会返回首页 HTML(状态码 200),这时 json() 会抛错 -> 视为没有素材
    const manifest = (await res.json()) as { actions: Record<string, ClipInfo> };
    const clips: LoadedFrames["clips"] = {};
    for (const [name, info] of Object.entries(manifest.actions)) {
      const images = await Promise.all(
        Array.from({ length: info.count }, (_, i) => loadImage(`${base}frames/${name}/${i + 1}.png`)),
      );
      clips[name] = { info, images };
    }
    return Object.keys(clips).length > 0 ? { clips } : null;
  } catch {
    return null;
  }
}

// 每个状态按优先级找素材,没有对应动作的图就用相近的动作顶上,最后兜底到待机
const CLIP_CHAIN: Record<RigState, string[]> = {
  idle: ["idle", "walk"],
  walking: ["walk", "idle"],
  run: ["run", "walk", "idle"],
  held: ["held", "idle"],
  sit: ["sit", "idle"],
  sleep: ["sleep", "sit", "idle"],
  look: ["look", "idle"],
  wave: ["wave", "idle"],
  dance: ["dance", "happy", "wave", "idle"],
  happy: ["happy", "dance", "wave", "idle"],
  hop: ["hop", "idle"],
  land: ["land", "idle"],
  surprise: ["surprise", "hop", "idle"],
  stretch: ["stretch", "idle"],
  spin: ["idle"],
};

// 每个状态"自己专属"的素材名。选中的素材不在这里面,说明是拿别的图顶替的,
// 这时用程序动作(弹跳、摇摆、压扁)补上动感,而不是让角色僵着不动。
const SPECIFIC: Record<RigState, string[]> = {
  idle: ["idle"],
  walking: ["walk"],
  run: ["run", "walk"],
  held: ["held"],
  sit: ["sit"],
  sleep: ["sleep"],
  look: ["look"],
  wave: ["wave"],
  dance: ["dance"],
  happy: ["happy"],
  hop: ["hop"],
  land: ["land"],
  surprise: ["surprise"],
  stretch: ["stretch"],
  spin: ["spin"],
};

interface Proc {
  dy: number; // 竖直位移(负数向上,CSS 像素)
  rot: number; // 绕脚底的倾斜(弧度,朝右为正,镜像由调用方处理)
  sx: number; // 横向缩放
  sy: number; // 纵向缩放
}

// 程序动作:只用一张静止图做出各种状态的动感。全部是平滑的正弦曲线,
// 而且以脚底为支点变形,所以不会像网格扭曲那样把角色拉变形,也不会一抽一抽。
function procedural(state: RigState, t: number): Proc {
  const p: Proc = { dy: 0, rot: 0, sx: 1, sy: 1 };
  const bounce = (freq: number, amp: number) => -Math.abs(Math.sin(t * freq)) * amp;
  switch (state) {
    case "walking":
      p.dy = bounce(9, 4);
      p.rot = Math.sin(t * 9) * 0.05;
      break;
    case "run":
      p.dy = bounce(14, 6);
      p.rot = 0.07 + Math.sin(t * 14) * 0.05; // 稍微前倾
      break;
    case "sit":
      p.sy = 0.86 + Math.sin(t * 1.8) * 0.008;
      p.sx = 1.06;
      break;
    case "sleep":
      p.sy = 0.82 + Math.sin(t * 1.4) * 0.012;
      p.sx = 1.07;
      p.rot = 0.09;
      break;
    case "wave":
      p.rot = Math.sin(t * 10) * 0.12;
      p.dy = bounce(10, 2);
      break;
    case "dance":
      p.rot = Math.sin(t * 8) * 0.14;
      p.dy = bounce(8, 5);
      break;
    case "happy":
      p.dy = bounce(10, 7);
      p.sy = 1 + Math.sin(t * 20) * 0.03;
      break;
    case "look":
      p.rot = Math.sin(t * 2) * 0.08;
      break;
    case "surprise":
      p.sy = 1.08;
      p.sx = 0.94;
      break;
    case "stretch":
      p.sy = 1 + 0.07 * Math.sin(t * 3);
      p.sx = 1 - 0.03 * Math.sin(t * 3);
      break;
    case "land":
      p.sy = 0.9;
      p.sx = 1.05;
      break;
    default:
      break;
  }
  return p;
}

const TAU = Math.PI * 2;
const GROUND_MARGIN = 6; // 必须和 prepare_frames.py 里 FRAME - BASELINE 的一半对应(CSS 像素)
const SHOT_DUR: Partial<Record<RigState, number>> = { hop: 0.76, spin: 0.95, surprise: 0.6, land: 0.38 };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (p: number) => p * p * (3 - 2 * p);

export function createSpriteRig(
  canvas: HTMLCanvasElement,
  frames: LoadedFrames,
  cssW: number,
  cssH: number,
): PetRig {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";

  const groundY = cssH - GROUND_MARGIN;
  const spriteH = 88; // 只用于"被提着"时的摆动支点

  let state: RigState = "idle";
  let facingLeft = false;
  let pressed = false;
  let pressW = 0;
  let sx = 1; // 当前横向缩放,从 1 过渡到 -1 就是一次转身
  let clipName = "";
  let clipSpeed = 1;
  // 没有专门素材、用走路/小跑的图顶替静止类状态时,只显示第一帧不播放,免得站着不动却在迈步
  let clipFreeze = false;
  let clipT0 = performance.now();
  let shotT0 = 0;
  let raf = 0;
  let disposed = false;
  let last = performance.now();

  function pickClip(s: RigState) {
    for (const name of CLIP_CHAIN[s]) {
      if (frames.clips[name]) {
        const moving = s === "walking" || s === "run";
        return {
          name,
          speed: s === "run" && name === "walk" ? 1.6 : 1,
          freeze: !moving && (name === "walk" || name === "run"),
        };
      }
    }
    return { name: Object.keys(frames.clips)[0], speed: 1, freeze: true };
  }

  function apply(next: RigState) {
    state = next;
    const c = pickClip(next);
    clipName = c.name;
    clipSpeed = c.speed;
    clipFreeze = c.freeze;
    clipT0 = performance.now();
    if (SHOT_DUR[next]) shotT0 = performance.now();
  }
  apply("idle");

  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    pressW += ((pressed ? 1 : 0) - pressW) * (1 - Math.exp(-12 * dt));
    sx += ((facingLeft ? -1 : 1) - sx) * (1 - Math.exp(-14 * dt));

    // 当前帧
    const clip = frames.clips[clipName];
    const n = clip.images.length;
    const step = ((now - clipT0) / 1000) * clip.info.fps * clipSpeed;
    let idx = 0;
    if (clipFreeze) {
      idx = 0;
    } else if (clip.info.mode === "once") {
      idx = Math.min(n - 1, Math.floor(step));
    } else if (clip.info.mode === "pingpong" && n > 1) {
      const cycle = 2 * n - 2;
      const k = Math.floor(step) % cycle;
      idx = k < n ? k : cycle - k;
    } else {
      idx = Math.floor(step) % n;
    }
    const img = clip.images[idx];

    // 一次性动作的离地高度和转圈
    let lift = 0;
    let spinScale = 1;
    const dur = SHOT_DUR[state];
    if (dur) {
      const p = clamp01((now - shotT0) / 1000 / dur);
      if (state === "hop") lift = 16 * Math.sin(Math.PI * clamp01((p - 0.18) / 0.52));
      else if (state === "spin") {
        lift = 10 * Math.sin(Math.PI * p);
        spinScale = Math.cos(TAU * ease(p));
      } else if (state === "surprise") lift = 7 * Math.sin(Math.PI * p);
    }

    // 用别的图顶替时补上程序动作
    const proc = SPECIFIC[state].includes(clipName)
      ? { dy: 0, rot: 0, sx: 1, sy: 1 }
      : procedural(state, t);
    const dir = facingLeft ? -1 : 1;

    // 被提着但没有专门的素材:用待机帧 + 左右晃荡顶上
    const dangling = state === "held" && clipName !== "held";
    const rot = dangling ? 0.09 * Math.sin(t * 5) : 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 地面影子:腾空越高越小越淡
    const shScale = Math.max(0.35, 1 - lift / 45);
    ctx.save();
    ctx.translate(cssW / 2, groundY);
    ctx.scale(shScale, shScale * 0.24);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
    g.addColorStop(0, `rgba(0,0,0,${0.45 * Math.max(0.25, 1 - lift / 40)})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, TAU);
    ctx.fill();
    ctx.restore();

    // 角色:以脚底中心为原点,画布整张贴上去(帧素材里脚底就在这条线上)
    ctx.save();
    ctx.translate(cssW / 2, groundY - lift + proc.dy);
    if (proc.rot) ctx.rotate(proc.rot * dir);
    if (dangling) {
      ctx.translate(0, -spriteH);
      ctx.rotate(rot);
      ctx.translate(0, spriteH);
    }
    // 静止时(只有一帧或用走路图顶替的静止状态)加一点呼吸起伏:以脚底为支点纵向微微伸缩,横向反向补偿
    const still = clipFreeze || n === 1;
    const breath = still && state !== "held" && state !== "sleep" && state !== "sit" ? 0.014 * Math.sin(t * 2.4) : 0;
    ctx.scale(
      sx * spinScale * (1 - breath * 0.6) * proc.sx,
      (1 - pressW * 0.05) * (1 + breath) * proc.sy,
    );
    ctx.drawImage(img, -cssW / 2, -groundY, cssW, cssH);
    ctx.restore();
  }
  frame();

  return {
    setState(next: RigState) {
      if (next !== state || SHOT_DUR[next]) apply(next);
    },
    setFacingLeft(left: boolean) {
      facingLeft = left;
    },
    setPressed(p: boolean) {
      pressed = p;
    },
    setPointer() {
      /* 逐帧素材里没有"转头看鼠标"的姿势,悬停反馈由外层 CSS 放大负责 */
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
}
