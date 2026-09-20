<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import mascotUrl from "./assets/mascot.png";
import type { PetRig, RigState } from "./petRig";
import { createPet } from "./pet";
import { getSettings } from "./settings";
import { dayKey, vocabList } from "./vocab";

const appWindow = getCurrentWindow();

// 必须和 src-tauri/src/lib.rs 里 create_ball_window 的 WIN_W / WIN_H 保持一致,
// 否则算出来的"站在地面上的坐标"会和窗口实际大小对不上,导致陷进任务栏或悬空。
// (宽度不能小于 Windows 窗口的最小宽度约 136px;高度里留出的空白用来放跳跃和头顶气泡)
const WIN_W = 140;
const WIN_H = 140;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const petState = ref<RigState>("idle");
const facingLeft = ref(false);
const pressed = ref(false);
const canvasEl = ref<HTMLCanvasElement | null>(null);
let rig: PetRig | null = null;
let stopped = false;

// 两种模式:散步 = 满屏溜达 + 各种小动作;休息 = 原地坐着、打盹、偶尔伸懒腰
type Mode = "stroll" | "rest";
const MODE_KEY = "pet.mode";
function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "rest" ? "rest" : "stroll";
  } catch {
    return "stroll";
  }
}
const mode = ref<Mode>(loadMode());
// 模式切换时置 true,正在进行的自主动作看到它就立刻收手,让循环按新模式重新选动作。
let modeDirty = false;

// 没有特殊事情发生时宠物"默认待着"的姿态:休息模式是坐着,散步模式是站着。
const restingState = (): RigState => (mode.value === "rest" ? "sit" : "idle");

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pickWeighted<T extends string>(table: [T, number][]): T {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let r = Math.random() * total;
  for (const [item, weight] of table) {
    r -= weight;
    if (r <= 0) return item;
  }
  return table[0][0];
}

// ---------------------------------------------------------------------------
// "有人在互动"标记:自主行为必须给用户的操作让路,不能争抢窗口位置
// ---------------------------------------------------------------------------
let holding = false; // 鼠标按着(点击或拖动过程中)
let busyUntil = 0; // 刚做完某个反应动作,要等一会儿再恢复自主行为
const isBusy = () => holding || performance.now() < busyUntil;
function busy(ms: number) {
  busyUntil = Math.max(busyUntil, performance.now() + ms);
}
const aborted = () => stopped || isBusy() || modeDirty;

// 可被打断的等待:一有互动或切换模式就提前结束
async function pause(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end && !aborted()) await sleep(80);
}

// ---------------------------------------------------------------------------
// 头顶气泡表情(♥ ♪ ! ? z)
// ---------------------------------------------------------------------------
interface Emote {
  id: number;
  text: string;
  x: number;
  color: string;
}
// ---------------------------------------------------------------------------
// 每日复习提醒:到了设定时间、还有到期的生词,宠物头顶冒一个气泡
// ---------------------------------------------------------------------------
const bubble = ref("");
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
const REMIND_KEY = "pet.remindedDay";

function showBubble(text: string, ms = 15000) {
  bubble.value = text;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubble.value = ""), ms);
}

async function checkReminder() {
  try {
    const st = await getSettings();
    if (!st.reminderEnabled) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    if (hm < st.reminderTime) return; // "HH:MM" 定长,字符串比较就是时间比较
    const today = dayKey(now.getTime());
    if (localStorage.getItem(REMIND_KEY) === today) return; // 今天已经提醒过
    const due = (await vocabList()).filter((e) => !e.mastered && e.nextReview <= Date.now()).length;
    localStorage.setItem(REMIND_KEY, today); // 没有到期词也记一笔,不要每分钟都重查
    if (due > 0) {
      showBubble(`📚 ${due} 个词要复习`);
      react("hop", 780, "♪", "#4facfe");
    }
  } catch {
    // 读设置/词库失败就下一分钟再试
  }
}
let reminderTimer: ReturnType<typeof setInterval> | undefined;

const emotes = ref<Emote[]>([]);
let emoteId = 0;
function spawnEmote(text: string, color = "#ff5d8f") {
  const id = ++emoteId;
  emotes.value.push({ id, text, x: randomBetween(-4, 24), color });
  setTimeout(() => {
    emotes.value = emotes.value.filter((e) => e.id !== id);
  }, 1700);
}

// 即时反应动作(被点、被摸):打断当前行为,播完再回到默认姿态
async function react(state: RigState, ms: number, emote?: string, color?: string) {
  busy(ms + 300);
  petState.value = state;
  if (emote) spawnEmote(emote, color);
  await sleep(ms);
  if (petState.value === state) petState.value = restingState();
}

// ---------------------------------------------------------------------------
// 地面 / 活动范围(物理像素)
// ---------------------------------------------------------------------------
interface Ground {
  minX: number;
  maxX: number;
  groundY: number; // 窗口左上角 y,此时窗口底边正好贴在工作区底边上
  scale: number;
}

// 用工作区(已扣除任务栏)而不是整块屏幕,这样宠物站在任务栏上沿而不是被任务栏盖住。
// 任何一步失败都返回 null,调用方跳过这一轮,不能让一次意外把循环卡死。
async function getGround(): Promise<Ground | null> {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const scale = monitor.scaleFactor;
    const wa = monitor.workArea;
    const winW = WIN_W * scale;
    const winH = WIN_H * scale;
    const margin = 6 * scale;
    return {
      minX: wa.position.x + margin,
      maxX: wa.position.x + wa.size.width - winW - margin,
      groundY: wa.position.y + wa.size.height - winH,
      scale,
    };
  } catch {
    return null;
  }
}

async function moveTo(x: number, y: number) {
  await appWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)));
}

// ---------------------------------------------------------------------------
// 拖动 / 点击
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD = 4;
let downX = 0;
let downY = 0;
let dragging = false;
// 系统原生拖动期间浏览器收不到任何鼠标事件,拖动一结束才会重新收到 mousemove / mouseleave,
// 以此作为"拖动结束"的信号(startDragging 本身没有结束回调)。
let nativeDragging = false;
let nativeDragStartedAt = 0;

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return; // 右键交给右键菜单
  downX = e.clientX;
  downY = e.clientY;
  dragging = false;
  pressed.value = true;
  holding = true;
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (dragging) return;
  const movedEnough =
    Math.abs(e.clientX - downX) > DRAG_THRESHOLD || Math.abs(e.clientY - downY) > DRAG_THRESHOLD;
  if (movedEnough) {
    dragging = true;
    nativeDragging = true;
    nativeDragStartedAt = performance.now();
    petState.value = "held"; // 被提起来:手脚乱晃
    appWindow.startDragging().catch(() => {});
    cleanupDrag();
  }
}

function onMouseUp() {
  pressed.value = false;
  if (!dragging) {
    holding = false;
    if (bubble.value) {
      // 提醒气泡还在:点宠物直接跳到生词本去复习
      bubble.value = "";
      invoke("open_main_window", { view: "vocab" }).catch(() => {});
    } else {
      invoke("toggle_main_window").catch(() => {});
    }
    // 被点一下:吓一跳,同时呼出/隐藏翻译面板
    react("surprise", 600, "!", "#ffb020");
    cleanupDrag();
  }
}

function cleanupDrag() {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("mouseup", onMouseUp);
}

// 拖动结束后的信号处理:放手后宠物受重力落回地面。
function onPostDragSignal() {
  // 刚开始拖的前几百毫秒可能还有残留的 mousemove,不能当成"拖动结束"。
  if (!nativeDragging || performance.now() - nativeDragStartedAt < 400) return;
  nativeDragging = false;
  pressed.value = false;
  fallToGround().finally(() => {
    holding = false;
    busy(500);
  });
}

// 重力下落 + 落地小反弹。时间步长用真实 dt,不依赖固定帧率。
async function fallToGround() {
  try {
    await doFall();
  } finally {
    // 无论是提前返回还是异常,都不能让宠物一直保持"被提着"的姿态。
    if (petState.value === "held") petState.value = restingState();
  }
}

async function doFall() {
  const ground = await getGround();
  if (!ground) return;
  let pos: PhysicalPosition;
  try {
    pos = await appWindow.outerPosition();
  } catch {
    return;
  }
  const x = Math.min(Math.max(pos.x, ground.minX), ground.maxX);
  let y = pos.y;
  if (y >= ground.groundY - 1 && x === pos.x) return;

  const g = 2400 * ground.scale; // 物理像素/秒²
  let vy = 0;
  let last = performance.now();
  let bounces = 0;
  petState.value = "held"; // 下落过程中仍是腾空姿态

  while (!stopped) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    vy += g * dt;
    y += vy * dt;
    if (y >= ground.groundY) {
      y = ground.groundY;
      if (vy > 350 * ground.scale && bounces < 2) {
        vy = -vy * 0.3;
        bounces++;
      } else {
        vy = 0;
        try {
          await moveTo(x, y);
        } catch {
          /* 忽略 */
        }
        break;
      }
    }
    try {
      await moveTo(x, y);
    } catch {
      return;
    }
    await sleep(16);
  }

  petState.value = "land";
  await sleep(380);
  if (petState.value === "land") petState.value = restingState();
}

// ---------------------------------------------------------------------------
// 鼠标停在身上:转身面向你;来回蹭 = 摸头,会开心;停久了会打招呼
// ---------------------------------------------------------------------------
let hovering = false;
let greetTimer: ReturnType<typeof setTimeout> | undefined;
let lastMX = 0;
let lastMY = 0;
let lastMT = 0;
let petScore = 0;

function onEnter(e: MouseEvent) {
  hovering = true;
  lastMX = e.clientX;
  lastMY = e.clientY;
  lastMT = performance.now();
  petScore = 0;
  rig?.setPointer(true);
  clearTimeout(greetTimer);
  greetTimer = setTimeout(() => {
    if (hovering && !isBusy() && petState.value === "idle") {
      react("wave", 1900, "♪", "#4facfe");
    }
  }, 1600);
}

function onLeave() {
  hovering = false;
  petScore = 0;
  rig?.setPointer(false);
  clearTimeout(greetTimer);
}

function onHoverMove(e: MouseEvent) {
  if (holding || nativeDragging) return;
  const now = performance.now();
  const dt = now - lastMT;
  lastMT = now;
  // 累积"来回蹭"的移动量,同时每毫秒衰减一点:只有持续快速晃动鼠标才会触发。
  petScore = Math.max(0, petScore - dt * 0.3) + Math.abs(e.clientX - lastMX) + Math.abs(e.clientY - lastMY);
  lastMX = e.clientX;
  lastMY = e.clientY;
  if (petScore > 380 && petState.value !== "happy") {
    petScore = 0;
    happyBurst();
  }
}

// 被摸得开心:身体抖动、举手,头顶连续冒爱心
async function happyBurst() {
  spawnEmote("♥");
  [600, 1200, 1800].forEach((delay) =>
    setTimeout(() => {
      if (petState.value === "happy") spawnEmote("♥");
    }, delay),
  );
  await react("happy", 2500);
}

// ---------------------------------------------------------------------------
// 右键菜单:切换散步 / 休息模式
// ---------------------------------------------------------------------------
function setMode(next: Mode) {
  if (mode.value === next) return;
  mode.value = next;
  modeDirty = true;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* 存不进去也不影响本次使用 */
  }
  if (next === "rest") {
    petState.value = "sit";
    spawnEmote("z", "#8aa0ff");
  } else {
    react("hop", 780, "♪", "#4facfe");
  }
}

async function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  busy(4000); // 菜单开着的时候宠物不要乱跑
  try {
    const menu = await Menu.new({
      items: [
        {
          id: "stroll",
          text: `${mode.value === "stroll" ? "✓ " : "    "}散步模式`,
          action: () => setMode("stroll"),
        },
        {
          id: "rest",
          text: `${mode.value === "rest" ? "✓ " : "    "}休息模式`,
          action: () => setMode("rest"),
        },
        { item: "Separator" },
        {
          id: "panel",
          text: "打开翻译面板",
          action: () => {
            invoke("toggle_main_window").catch(() => {});
          },
        },
        {
          id: "skin",
          text: "更换桌宠形象…",
          action: () => {
            invoke("open_main_window", { view: "pets" }).catch(() => {});
          },
        },
      ],
    });
    await menu.popup();
  } catch (err) {
    console.error("右键菜单失败", err);
  }
}

// ---------------------------------------------------------------------------
// 自主行为
// ---------------------------------------------------------------------------

// 保持一个持续型状态 ms 毫秒,期间可以每隔一段时间冒一个头顶气泡
async function sustain(
  state: RigState,
  ms: number,
  emote?: { text: string; every: number; color?: string },
) {
  petState.value = state;
  const end = performance.now() + ms;
  let nextEmote = performance.now() + 300;
  while (performance.now() < end && !aborted()) {
    if (emote && performance.now() >= nextEmote) {
      spawnEmote(emote.text, emote.color);
      nextEmote += emote.every;
    }
    await sleep(80);
  }
}

// 一次性动作(跳、转圈、伸懒腰):播完回到默认姿态;中途若被别的反应接管,就不再覆盖
async function oneShotAction(state: RigState, ms: number) {
  petState.value = state;
  await sleep(ms);
  if (petState.value === state) petState.value = restingState();
}

async function walkTo(targetX: number, run: boolean) {
  const ground = await getGround();
  if (!ground) return;
  let pos: PhysicalPosition;
  try {
    pos = await appWindow.outerPosition();
  } catch {
    return;
  }

  const startX = pos.x;
  const clampedTarget = Math.min(Math.max(targetX, ground.minX), ground.maxX);
  const dir = clampedTarget >= startX ? 1 : -1;
  const total = Math.abs(clampedTarget - startX);
  if (total < 20 * ground.scale) return;

  const cruise = (run ? 96 : 42) * ground.scale; // 物理像素/秒:小跑比散步快一倍多
  facingLeft.value = dir < 0;
  petState.value = run ? "run" : "walking";

  let x = startX;
  let last = performance.now();
  while (!aborted()) {
    const now = performance.now();
    const dt = Math.min(0.06, (now - last) / 1000);
    last = now;

    // 起步/收步各留一段减速区,像真的在迈步启动和停下,而不是匀速滑行。
    const travelled = Math.abs(x - startX);
    const remaining = total - travelled;
    const ramp = 46 * ground.scale;
    const factor = Math.min(1, Math.max(0.2, Math.min(travelled, remaining) / ramp));
    x += dir * cruise * factor * dt;

    const arrived = dir > 0 ? x >= clampedTarget : x <= clampedTarget;
    if (arrived) x = clampedTarget;
    try {
      // y 每帧都强制回到地面,避免任何原因造成的悬空或陷进任务栏。
      await moveTo(x, ground.groundY);
    } catch {
      break;
    }
    if (arrived) break;
    await sleep(24);
  }
  if (petState.value === "walking" || petState.value === "run") petState.value = restingState();
}

async function walkToRandom(run: boolean) {
  const ground = await getGround();
  if (!ground) {
    await sleep(1500);
    return;
  }
  let target = randomBetween(ground.minX, ground.maxX);
  try {
    const pos = await appWindow.outerPosition();
    // 至少走出一小段距离,不要原地抖两步就算"走过"。
    if (Math.abs(target - pos.x) < 140 * ground.scale) {
      target = pos.x < (ground.minX + ground.maxX) / 2 ? ground.maxX - 30 : ground.minX + 30;
    }
  } catch {
    /* 拿不到当前位置就直接用随机目标 */
  }
  await walkTo(target, run);
}

// 散步模式:溜达为主,穿插各种小动作
async function strollStep() {
  petState.value = "idle";
  await pause(randomBetween(2200, 5200)); // 停留时间随机,太固定会像机器人
  if (aborted()) return;

  const action = pickWeighted([
    ["walk", 34],
    ["run", 8],
    ["hop", 10],
    ["look", 10],
    ["wave", 8],
    ["dance", 8],
    ["spin", 6],
    ["stretch", 7],
    ["sit", 9],
  ]);

  switch (action) {
    case "walk":
      await walkToRandom(false);
      break;
    case "run":
      await walkToRandom(true);
      break;
    case "hop":
      await oneShotAction("hop", 780);
      break;
    case "look":
      await sustain("look", randomBetween(2600, 4200), { text: "?", every: 1500, color: "#7a8cff" });
      break;
    case "wave":
      await sustain("wave", 1900);
      break;
    case "dance":
      await sustain("dance", randomBetween(3000, 5200), { text: "♪", every: 650, color: "#ff8a3d" });
      break;
    case "spin":
      await oneShotAction("spin", 980);
      break;
    case "stretch":
      await oneShotAction("stretch", 1900);
      break;
    case "sit":
      await sustain("sit", randomBetween(4000, 7000));
      break;
  }
}

// 休息模式:原地坐着,时不时打个盹、伸个懒腰、东张西望
async function restStep() {
  if (petState.value !== "sit") petState.value = "sit";
  await pause(randomBetween(5000, 9000));
  if (aborted()) return;

  const action = pickWeighted([
    ["sleep", 45],
    ["stretch", 25],
    ["look", 15],
    ["sit", 15],
  ]);

  switch (action) {
    case "sleep":
      await sustain("sleep", randomBetween(9000, 20000), { text: "z", every: 1800, color: "#8aa0ff" });
      break;
    case "stretch":
      await oneShotAction("stretch", 1900);
      break;
    case "look":
      await sustain("look", randomBetween(2600, 4000), { text: "?", every: 1500, color: "#7a8cff" });
      break;
    case "sit":
      await pause(randomBetween(4000, 8000));
      break;
  }
  if (!aborted() && mode.value === "rest") petState.value = "sit";
}

async function behaviourLoop() {
  while (!stopped) {
    if (isBusy()) {
      await sleep(150);
      continue;
    }
    modeDirty = false;
    try {
      if (mode.value === "rest") await restStep();
      else await strollStep();
    } catch {
      await sleep(500); // 某一步出错不能让整个行为循环死掉
    }
  }
}

// 在设置里切换/上传形象后,渲染器要换成新素材。同一个 canvas 拿到 2D 上下文后
// 不能再换别的类型,最简单可靠的办法就是让这个小窗口整页重载一次。
let unlistenPet: UnlistenFn | undefined;

onMounted(() => {
  setTimeout(checkReminder, 15000);
  reminderTimer = setInterval(checkReminder, 60000);
  listen("pet-changed", () => window.location.reload()).then((u) => {
    if (stopped) u();
    else unlistenPet = u;
  });
  if (canvasEl.value) {
    // 渲染器异步创建(要先检查有没有逐帧素材),创建好之后把当时的状态同步过去
    createPet(canvasEl.value, mascotUrl, WIN_W, WIN_H).then((r) => {
      if (stopped) {
        r.dispose();
        return;
      }
      rig = r;
      r.setFacingLeft(facingLeft.value);
      r.setPressed(pressed.value);
      r.setState(petState.value);
    });
    watch(petState, (st) => rig?.setState(st));
    watch(facingLeft, (left) => rig?.setFacingLeft(left));
    watch(pressed, (p) => rig?.setPressed(p));
  }
  if (mode.value === "rest") petState.value = "sit";
  window.addEventListener("mousemove", onPostDragSignal);
  document.documentElement.addEventListener("mouseleave", onPostDragSignal);
  behaviourLoop();
});

onUnmounted(() => {
  stopped = true;
  unlistenPet?.();
  if (reminderTimer) clearInterval(reminderTimer);
  if (bubbleTimer) clearTimeout(bubbleTimer);
  rig?.dispose();
  cleanupDrag();
  clearTimeout(greetTimer);
  window.removeEventListener("mousemove", onPostDragSignal);
  document.documentElement.removeEventListener("mouseleave", onPostDragSignal);
});
</script>

<template>
  <div class="wrap">
    <div
      class="figure"
      :class="{ pressed }"
      @mousedown="onMouseDown"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @mousemove="onHoverMove"
      @contextmenu="onContextMenu"
    >
      <canvas ref="canvasEl" class="stage"></canvas>
    </div>
    <div v-if="bubble" class="bubble">{{ bubble }}</div>
    <div class="emotes">
      <span
        v-for="e in emotes"
        :key="e.id"
        class="emote"
        :style="{ left: `calc(50% + ${e.x}px)`, color: e.color }"
        >{{ e.text }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: hidden;
}

/* 角色本身的动作(走路、呼吸、跳跃、转身、坐、睡……)全部在 petRig.ts 里按部位做变形,
   这里只负责"被鼠标摸到"的整体反馈。 */
.figure {
  width: 100%;
  height: 100%;
  cursor: pointer;
  user-select: none;
  transform-origin: 50% 100%;
  transition: transform 0.15s ease;
}

.figure:hover {
  transform: scale(1.05);
}

.figure.pressed {
  transform: scale(0.97);
}

.stage {
  display: block;
  pointer-events: none;
}

/* 头顶气泡:从头顶附近冒出来,一边上飘一边淡出 */
.bubble {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 132px;
  padding: 4px 9px;
  border-radius: 12px;
  background: #fff;
  color: #3b4bdc;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: 0 2px 7px rgba(30, 40, 90, 0.28);
  pointer-events: none;
  animation: bubble-in 0.25s ease-out;
}
@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%);
  }
}
.emotes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.emote {
  position: absolute;
  bottom: 92px;
  font-size: 16px;
  font-weight: 700;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  animation: emote-float 1.6s ease-out forwards;
}

@keyframes emote-float {
  0% {
    opacity: 0;
    transform: translateY(0) scale(0.6);
  }
  15% {
    opacity: 1;
    transform: translateY(-4px) scale(1);
  }
  100% {
    opacity: 0;
    transform: translateY(-30px) scale(1.15);
  }
}
</style>
