import * as THREE from "three";

// 单张 2D 图想让"角色本身在动",做法是把图贴到一张细分网格上,
// 每帧按身体部位(脚、手、尾巴、头、肚子)分别移动网格顶点 —— 相当于"木偶变形"。
// 部位坐标 (u, v) 是相对 mascot.png 的归一化位置:u 从左到右,v 从上到下。

// 持续型状态:一直保持到被换掉
//   idle 待机 / walking 散步 / run 小跑 / held 被提起 / sit 坐着休息 / sleep 睡觉
//   look 东张西望 / wave 挥手 / dance 跳舞 / happy 被摸得开心
// 一次性动作:播完自动回到"无状态"
//   hop 原地跳 / land 落地 / surprise 受惊 / stretch 伸懒腰 / spin 转圈
export type RigState =
  | "idle"
  | "walking"
  | "run"
  | "held"
  | "sit"
  | "sleep"
  | "look"
  | "wave"
  | "dance"
  | "happy"
  | "hop"
  | "land"
  | "surprise"
  | "stretch"
  | "spin";

interface Blob {
  u: number;
  v: number;
  su: number; // 影响范围(归一化)
  sv: number;
  phase: number; // 步态相位偏移,对角线的腿相位相反
}

// 三条腿(原图里能看到的落地部位)
const FEET: Blob[] = [
  { u: 0.39, v: 0.92, su: 0.09, sv: 0.07, phase: 0 },
  { u: 0.82, v: 0.9, su: 0.08, sv: 0.08, phase: Math.PI },
  { u: 0.12, v: 0.86, su: 0.1, sv: 0.08, phase: Math.PI },
];

// 四只小手。isRight 标记右侧的两只,挥手时只举右边的
const HANDS: (Blob & { isRight: boolean })[] = [
  { u: 0.41, v: 0.49, su: 0.07, sv: 0.05, phase: 0, isRight: false },
  { u: 0.81, v: 0.49, su: 0.06, sv: 0.05, phase: Math.PI, isRight: true },
  { u: 0.45, v: 0.65, su: 0.07, sv: 0.06, phase: Math.PI, isRight: false },
  { u: 0.89, v: 0.63, su: 0.06, sv: 0.06, phase: 0, isRight: true },
];

// 头盔和身体的分界线附近作为"脖子",头盔绕这里转动
const NECK = { u: 0.52, v: 0.5 };

const SPRITE_H = 88; // 角色在窗口里的显示高度(CSS 像素)
const SPRITE_W = SPRITE_H * 0.75; // mascot.png 宽高比 225:300
const GROUND_MARGIN = 6; // 脚底离窗口底边的距离,给影子留位置
const GRID_X = 26;
const GRID_Y = 34;
const TAU = Math.PI * 2;
// 变形幅度总系数:单张图拉伸得越狠越扭曲,只保留轻微的呼吸、摇摆和点头。
const WARP = 0.4;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function gauss(u: number, v: number, b: Blob) {
  const du = (u - b.u) / b.su;
  const dv = (v - b.v) / b.sv;
  return Math.exp(-(du * du + dv * dv));
}

// ---- 一次性动作 ----
// kf: [进度, 纵向缩放, 离地高度px]。其余是随进度变化的附加量。
type Keyframe = [number, number, number];
interface OneShot {
  dur: number;
  kf: Keyframe[];
  hands?: (p: number) => number; // 双手举起程度 0..1
  head?: (p: number) => number; // 头的额外转角(弧度,负=前倾)
  spin?: (p: number) => number; // 额外的绕竖轴转角
}

const env = (p: number) => Math.sin(Math.PI * p);
const ease = (p: number) => p * p * (3 - 2 * p);

const ONE_SHOTS: Record<string, OneShot> = {
  hop: {
    dur: 0.76,
    kf: [
      [0, 1, 0],
      [0.18, 0.9, 0],
      [0.45, 1.08, 16],
      [0.7, 0.9, 0],
      [0.85, 1.03, 2],
      [1, 1, 0],
    ],
  },
  land: {
    dur: 0.38,
    kf: [
      [0, 0.82, 0],
      [0.55, 1.05, 0],
      [1, 1, 0],
    ],
  },
  // 受惊:猛地拔高、双手举起、头往后仰,然后缓下来
  surprise: {
    dur: 0.6,
    kf: [
      [0, 1, 0],
      [0.15, 1.13, 7],
      [0.5, 1.06, 3],
      [1, 1, 0],
    ],
    hands: (p) => env(p),
    head: (p) => 0.12 * env(p),
  },
  // 伸懒腰:身体慢慢拉高并停住,双手举高、头后仰,然后松下来
  stretch: {
    dur: 1.9,
    kf: [
      [0, 1, 0],
      [0.35, 1.15, 0],
      [0.62, 1.15, 0],
      [0.85, 0.93, 0],
      [1, 1, 0],
    ],
    hands: (p) => smoothstep(0.05, 0.35, p) * (1 - smoothstep(0.62, 0.9, p)),
    head: (p) => 0.14 * smoothstep(0.05, 0.35, p) * (1 - smoothstep(0.62, 0.9, p)),
  },
  // 转圈:小跳的同时绕竖轴转整整一圈,这是"真 3D 转身"最直观的展示
  spin: {
    dur: 0.95,
    kf: [
      [0, 1, 0],
      [0.15, 0.94, 0],
      [0.5, 1.06, 10],
      [0.85, 0.95, 0],
      [1, 1, 0],
    ],
    spin: (p) => TAU * ease(p),
  },
};

function sampleKeyframes(kf: Keyframe[], p: number): { s: number; y: number } {
  for (let i = 1; i < kf.length; i++) {
    if (p <= kf[i][0]) {
      const [p0, s0, y0] = kf[i - 1];
      const [p1, s1, y1] = kf[i];
      const t = (p - p0) / (p1 - p0);
      const e = t * t * (3 - 2 * t);
      return { s: s0 + (s1 - s0) * e, y: y0 + (y1 - y0) * e };
    }
  }
  return { s: 1, y: 0 };
}

export interface PetRig {
  setState(state: RigState): void;
  setFacingLeft(left: boolean): void;
  setPressed(pressed: boolean): void;
  // 鼠标是否停在宠物身上:它会转身面向你、抬手
  setPointer(over: boolean): void;
  dispose(): void;
}

interface Weights {
  walk: number;
  run: number;
  held: number;
  sit: number;
  sleep: number;
  look: number;
  wave: number;
  dance: number;
  happy: number;
  pointer: number;
  press: number;
}

export function createPetRig(
  canvas: HTMLCanvasElement,
  textureUrl: string,
  cssW: number,
  cssH: number,
): PetRig {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(cssW, cssH, true);

  const scene = new THREE.Scene();

  // 用带一点透视的相机而不是正交相机:角色转身时才会有"立体转过去"的感觉,
  // 而不是纯粹被压扁。相机距离按 1:1 像素对应算出来。
  const fov = 20;
  const dist = cssH / 2 / Math.tan((fov * Math.PI) / 360);
  const camera = new THREE.PerspectiveCamera(fov, cssW / cssH, 10, dist * 4);
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);

  // ---- 角色网格 ----
  const geometry = new THREE.PlaneGeometry(SPRITE_W, SPRITE_H, GRID_X, GRID_Y);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const count = pos.count;
  const baseU = new Float32Array(count);
  const baseV = new Float32Array(count); // v 从上到下
  const bulge = new Float32Array(count); // 假的厚度,转身时产生视差,看起来圆润有体积
  for (let i = 0; i < count; i++) {
    const u = uv.getX(i);
    const v = 1 - uv.getY(i);
    baseU[i] = u;
    baseV[i] = v;
    const du = (u - 0.5) / 0.55;
    const dv = (v - 0.6) / 0.5;
    bulge[i] = Math.sqrt(Math.max(0, 1 - du * du - dv * dv));
  }

  const texture = new THREE.TextureLoader().load(textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  // 图片带透明边缘,必须按预乘 alpha 上传和混合,否则线性过滤会在轮廓上出黑边。
  texture.premultiplyAlpha = true;
  texture.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    premultipliedAlpha: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const originY = -cssH / 2 + GROUND_MARGIN; // 网格原点 = 脚底中心
  mesh.position.set(0, originY, 0);
  scene.add(mesh);

  // ---- 地面影子 ----
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 64;
  shadowCanvas.height = 16;
  const sctx = shadowCanvas.getContext("2d")!;
  const grad = sctx.createRadialGradient(32, 8, 0, 32, 8, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  sctx.setTransform(1, 0, 0, 0.25, 0, 6);
  sctx.fillStyle = grad;
  sctx.fillRect(0, -32, 64, 64);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  shadowTex.colorSpace = THREE.SRGBColorSpace;
  shadowTex.premultiplyAlpha = true;
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(58, 14), shadowMat);
  shadow.position.set(0, originY + 1, -3);
  scene.add(shadow);

  // ---- 动画状态 ----
  let state: RigState = "idle";
  let facingLeft = false;
  let pressed = false;
  let pointerOver = false;
  const w: Weights = {
    walk: 0,
    run: 0,
    held: 0,
    sit: 0,
    sleep: 0,
    look: 0,
    wave: 0,
    dance: 0,
    happy: 0,
    pointer: 0,
    press: 0,
  };
  let phase = 0; // 步态相位,一个周期 = 走两步
  let breathPhase = 0;
  let yaw = 0;
  let oneShot: { def: OneShot; t0: number } | null = null;
  const clock = { start: performance.now(), last: performance.now() };
  let raf = 0;
  let disposed = false;

  // 每帧按"权重"混合各个动作,而不是按状态硬切,这样状态切换时姿势是平滑过渡的。
  const feetDx = new Float32Array(FEET.length);
  const feetDy = new Float32Array(FEET.length);
  const handDx = new Float32Array(HANDS.length);
  const handDy = new Float32Array(HANDS.length);

  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - clock.last) / 1000);
    clock.last = now;
    const t = (now - clock.start) / 1000;

    const follow = 1 - Math.exp(-9 * dt);
    const target = (on: boolean) => (on ? 1 : 0);
    w.walk += (target(state === "walking" || state === "run") - w.walk) * follow;
    w.run += (target(state === "run") - w.run) * follow;
    w.held += (target(state === "held") - w.held) * follow;
    w.sit += (target(state === "sit") - w.sit) * follow;
    w.sleep += (target(state === "sleep") - w.sleep) * follow;
    w.look += (target(state === "look") - w.look) * follow;
    w.wave += (target(state === "wave") - w.wave) * follow;
    w.dance += (target(state === "dance") - w.dance) * follow;
    w.happy += (target(state === "happy") - w.happy) * follow;
    w.press += (target(pressed) - w.press) * follow;
    // 睡着/被提起时不理会鼠标
    const canNotice = pointerOver && state !== "sleep" && state !== "held";
    w.pointer += (target(canNotice) - w.pointer) * follow;

    const sitAmt = Math.max(w.sit, w.sleep); // 睡觉也是坐姿的延伸
    const wIdle = Math.max(0, 1 - w.walk - w.held - sitAmt - w.dance - w.happy);
    const runAmp = 1 + 0.6 * w.run;

    phase += dt * TAU * (1.6 + 1.3 * w.run) * w.walk;
    // 呼吸节奏随状态变:待机 3.4s,坐着 4.2s,睡觉更慢更深
    const breathPeriod = 3.4 + 0.8 * w.sit + 2.1 * w.sleep;
    breathPhase += (dt * TAU) / breathPeriod;
    const breath = Math.sin(breathPhase);

    // 一次性动作
    let osS = 1;
    let osY = 0;
    let osHands = 0;
    let osHead = 0;
    let osSpin = 0;
    if (oneShot) {
      const p = (now - oneShot.t0) / 1000 / oneShot.def.dur;
      if (p >= 1) {
        oneShot = null;
      } else {
        const k = sampleKeyframes(oneShot.def.kf, p);
        osS = k.s;
        osY = k.y;
        osHands = oneShot.def.hands?.(p) ?? 0;
        osHead = oneShot.def.head?.(p) ?? 0;
        osSpin = oneShot.def.spin?.(p) ?? 0;
      }
    }

    const danceP = t * TAU * 2.4; // 跳舞节拍 2.4Hz
    const happyP = t * TAU * 3; // 开心抖动 3Hz

    // 整体纵向缩放(以脚底为支点)
    const S =
      1 +
      w.walk * 0.03 * runAmp * Math.cos(2 * phase) +
      (wIdle * 0.02 + w.sit * 0.02 + w.sleep * 0.03) * breath +
      w.held * 0.07 -
      sitAmt * 0.15 -
      w.press * 0.05 +
      w.dance * 0.05 * Math.sin(danceP) +
      w.happy * 0.035 * Math.sin(happyP);

    // 头盔转角(正=向后仰,负=向前低头)
    const headAngle =
      w.walk * 0.075 * runAmp * Math.sin(phase - 0.9) +
      wIdle * 0.02 * Math.sin(t * 1.25) +
      w.held * 0.1 * Math.sin(t * 4) -
      w.sleep * 0.24 +
      w.sleep * 0.02 * Math.sin(t * 0.6) +
      w.sit * 0.03 * Math.sin(t * 0.5) +
      w.dance * 0.12 * Math.sin(danceP + 1) +
      w.look * 0.06 * Math.sin(t * 0.9 + 1) +
      w.happy * 0.08 * Math.sin(happyP) +
      w.pointer * -0.04 +
      osHead;
    const cosA = Math.cos(headAngle);
    const sinA = Math.sin(headAngle);

    const bobBase = w.walk * 2.4 * runAmp * Math.abs(Math.sin(phase));
    // 整体弹跳(舞蹈、开心时身体一颠一颠)
    const bounce =
      w.dance * 3 * Math.abs(Math.sin(danceP / 2)) + w.happy * 3 * Math.abs(Math.sin(happyP / 2));
    const lean = w.run * 3.5; // 小跑时身体前倾
    const swayAmp =
      w.walk * 3.0 * runAmp * Math.sin(phase) +
      wIdle * 0.4 * Math.sin(t * 0.9) +
      w.dance * 5 * Math.sin(t * TAU * 1.2) +
      w.happy * 3 * Math.sin(happyP) +
      lean;

    // 预先算好每条腿/每只手的位移,顶点循环里只需要乘高斯权重
    for (let i = 0; i < FEET.length; i++) {
      const b = FEET[i];
      const ph = phase + b.phase;
      const lift = Math.max(0, Math.sin(ph));
      feetDy[i] =
        w.walk * 5.0 * runAmp * lift +
        w.held * (-3 + 2.5 * Math.sin(t * 6 + b.phase)) +
        w.dance * 3 * Math.max(0, Math.sin(danceP + b.phase)) +
        sitAmt * 1.2;
      feetDx[i] = w.walk * 2.6 * runAmp * Math.cos(ph) + w.held * 3 * Math.sin(t * 5 + b.phase);
    }
    for (let i = 0; i < HANDS.length; i++) {
      const b = HANDS[i];
      const ph = phase + b.phase;
      const waving = b.isRight ? w.wave : 0;
      handDy[i] =
        w.walk * 2.2 * runAmp * Math.sin(ph) +
        wIdle * 1.1 * Math.sin(t * 1.9 + b.phase * 0.7) +
        w.held * 3.5 * Math.sin(t * 7 + b.phase) +
        w.dance * 4 * Math.sin(t * 15 + b.phase) +
        w.happy * (3 + 1.5 * Math.sin(t * 12 + b.phase)) +
        w.pointer * 1.0 +
        osHands * 5 +
        waving * (4.5 + 3 * Math.sin(t * 11)) -
        sitAmt * 0.6;
      handDx[i] =
        w.walk * 1.6 * runAmp * Math.cos(ph) +
        w.held * 2 * Math.cos(t * 7 + b.phase) +
        waving * 2.2 * Math.sin(t * 11 + 1);
    }
    const tailDx =
      w.walk * 3.2 * runAmp * Math.sin(phase + 0.5) +
      wIdle * 1.6 * Math.sin(t * 1.6) +
      w.held * 3 * Math.sin(t * 5) +
      w.dance * 4 * Math.sin(danceP) +
      w.happy * 3 * Math.sin(happyP) +
      w.sleep * 0.5 * Math.sin(t * 0.7) +
      w.sit * 0.8 * Math.sin(t * 1.1);
    const tailDy = w.walk * 1.2 * Math.sin(phase + 1.4);

    const SS = S * osS;
    const lift = osY + bounce;

    for (let i = 0; i < count; i++) {
      const u = baseU[i];
      const v = baseV[i];
      const up = 1 - v; // 0=脚底 1=头顶
      let dx = 0;
      let dy = 0;

      // 身体起伏:脚底一带保持不动,越往上跟着走得越明显
      dy += bobBase * smoothstep(0.02, 0.4, up);

      // 左右摇摆 / 前倾:越高摆得越大
      dx += swayAmp * Math.pow(up, 1.4);

      // 头盔绕脖子延迟转动:头比身子慢半拍,是活物的关键
      const wh = smoothstep(0.58, 0.42, v);
      if (wh > 0) {
        const px = (u - NECK.u) * SPRITE_W;
        const py = (NECK.v - v) * SPRITE_H;
        dx += wh * (px * cosA - py * sinA - px);
        dy += wh * (px * sinA + py * cosA - py);
      }

      for (let f = 0; f < FEET.length; f++) {
        const g = gauss(u, v, FEET[f]);
        if (g < 0.01) continue;
        dx += g * feetDx[f];
        dy += g * feetDy[f];
      }
      for (let h = 0; h < HANDS.length; h++) {
        const g = gauss(u, v, HANDS[h]);
        if (g < 0.01) continue;
        dx += g * handDx[h];
        dy += g * handDy[h];
      }

      // 尾巴(图左侧的蓝色身体尾段)
      const tw = smoothstep(0.32, 0.0, u) * smoothstep(0.55, 0.75, v);
      if (tw > 0) {
        dx += tw * tailDx;
        dy += tw * tailDy;
      }

      dx *= WARP;
      dy *= WARP;
      // 整体压扁拉伸(坐下、被提起、跳跃)是姿势本身,不属于"局部拉扯",单独加回来,不受 WARP 影响
      dy += (SS - 1) * up * SPRITE_H;
      dx += -(SS - 1) * 0.5 * (u - 0.5) * SPRITE_W;
      dy += lift;
      pos.setXYZ(i, (u - 0.5) * SPRITE_W + dx, up * SPRITE_H + dy, bulge[i] * 22);
    }
    pos.needsUpdate = true;

    // 转身:朝左 = 绕竖轴转 180°,背面正好是镜像贴图,所以是一次真的"转过去"而不是瞬间翻转。
    const targetYaw = facingLeft ? Math.PI : 0;
    yaw += (targetYaw - yaw) * (1 - Math.exp(-10 * dt));
    const wobble =
      w.walk * 0.14 * Math.sin(phase) +
      wIdle * 0.06 * Math.sin(t * 0.7) +
      w.look * 0.7 * Math.sin(t * 0.9) +
      w.dance * 0.45 * Math.sin(t * TAU * 1.2) +
      osSpin -
      w.pointer * 0.55; // 鼠标停在身上时,把正面转向镜头(也就是转向你)
    mesh.rotation.y = yaw + (facingLeft ? -wobble : wobble);

    // 影子:腾空越高越小越淡
    const airborne = lift + bobBase * 0.6;
    const sh = Math.max(0.35, 1 - airborne / 45);
    shadow.scale.set(sh, sh, 1);
    shadowMat.opacity = Math.max(0.25, 1 - airborne / 40);

    renderer.render(scene, camera);
  }
  frame();

  return {
    setState(next: RigState) {
      const shot = ONE_SHOTS[next];
      if (shot) {
        // 一次性动作:播放动画,同时把持续型状态清零(播完自然回到待机姿态)
        oneShot = { def: shot, t0: performance.now() };
      }
      state = next;
    },
    setFacingLeft(left: boolean) {
      facingLeft = left;
    },
    setPressed(p: boolean) {
      pressed = p;
    },
    setPointer(over: boolean) {
      pointerOver = over;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      shadowTex.dispose();
      shadowMat.dispose();
      renderer.dispose();
    },
  };
}
