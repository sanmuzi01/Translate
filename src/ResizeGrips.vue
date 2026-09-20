<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";

// 无边框窗口没有系统自带的缩放边框。窗口四周有 10px 透明边距(留给阴影),
// 系统能识别的"边缘"在最外侧的透明区里,用户对着看得见的卡片边缘拖是拖不动的。
// 所以在可见卡片的边缘上放一圈看不见的"拖拽条",按下时让系统开始缩放。
const win = getCurrentWindow();

type Dir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

function start(dir: Dir, e: MouseEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  win.startResizeDragging(dir).catch(() => {});
}
</script>

<template>
  <div class="grips">
    <div class="g n" @mousedown="start('North', $event)" />
    <div class="g s" @mousedown="start('South', $event)" />
    <div class="g w" @mousedown="start('West', $event)" />
    <div class="g e" @mousedown="start('East', $event)" />
    <div class="g nw" @mousedown="start('NorthWest', $event)" />
    <div class="g ne" @mousedown="start('NorthEast', $event)" />
    <div class="g sw" @mousedown="start('SouthWest', $event)" />
    <div class="g se" @mousedown="start('SouthEast', $event)" />
    <!-- 右下角的小标记,提示这个窗口可以拖着调整大小 -->
    <svg class="mark" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M11 3L3 11M11 7L7 11" />
    </svg>
  </div>
</template>

<style scoped>
/* 拖拽条压在卡片边缘上(卡片距窗口边 10px,条从 5px 到 15px 骑在边缘两侧) */
.g {
  position: fixed;
  z-index: 50;
}
.n,
.s {
  left: 20px;
  right: 20px;
  height: 10px;
  cursor: ns-resize;
}
.n {
  top: 5px;
}
.s {
  bottom: 5px;
}
.w,
.e {
  top: 20px;
  bottom: 20px;
  width: 10px;
  cursor: ew-resize;
}
.w {
  left: 5px;
}
.e {
  right: 5px;
}
.nw,
.ne,
.sw,
.se {
  width: 16px;
  height: 16px;
}
.nw {
  top: 5px;
  left: 5px;
  cursor: nwse-resize;
}
.se {
  bottom: 5px;
  right: 5px;
  cursor: nwse-resize;
}
.ne {
  top: 5px;
  right: 5px;
  cursor: nesw-resize;
}
.sw {
  bottom: 5px;
  left: 5px;
  cursor: nesw-resize;
}

.mark {
  position: fixed;
  right: 14px;
  bottom: 14px;
  width: 10px;
  height: 10px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.4;
  stroke-linecap: round;
  opacity: 0.55;
  pointer-events: none;
}
</style>
