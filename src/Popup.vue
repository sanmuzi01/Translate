<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import ResizeGrips from "./ResizeGrips.vue";
import { useCopy, useTranslator } from "./translate";

const appWindow = getCurrentWindow();
const { sourceText, resultText, loading, errorMsg, vocabInfo, run } = useTranslator();
const { copied, copy } = useCopy();

let unlistenEvent: UnlistenFn | undefined;

// 新一段划词内容到来:先把原文显示出来,再发起翻译(译文回来前显示骨架屏)
function onText(text: string) {
  sourceText.value = text;
  run(text);
}

// 弹窗是复用的(见 Rust 端 show_quick_translate_popup),所以关闭按钮只隐藏窗口,
// 不销毁它,这样下次划词能直接复用、不用重新创建/加载页面。失焦自动收起由 Rust 端负责。
function closePopup() {
  appWindow.hide();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closePopup();
}

// 卡片里右键:复制 / 翻译选中内容
async function showContextMenu(e: MouseEvent) {
  e.preventDefault();
  const selected = (window.getSelection()?.toString() ?? "").trim();
  const menu = await Menu.new({
    items: [
      await PredefinedMenuItem.new({ item: "Copy", text: "复制" }),
      await PredefinedMenuItem.new({ item: "SelectAll", text: "全选" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: selected ? "翻译选中内容" : "翻译选中内容(请先选中文字)",
        enabled: !!selected,
        action: () => {
          sourceText.value = selected;
          run(selected);
        },
      }),
    ],
  });
  await menu.popup();
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);

  // 弹窗第一次被创建时,Rust 端很可能在这个组件的事件监听器注册完成之前
  // 就已经 emit 过一次 quick-translate 事件了,直接监听会错过第一条内容,
  // 所以启动时先主动向 Rust 要一次“待处理内容”兜底。
  try {
    const pending = await invoke<string | null>("get_pending_translation");
    if (pending) onText(pending);
  } catch {
    // 忽略:拿不到待处理内容就等后续事件
  }

  unlistenEvent = await listen<string>("quick-translate", (event) => {
    onText(event.payload);
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  unlistenEvent?.();
});
</script>

<template>
  <ResizeGrips />
  <!-- 译文卡片 -->
  <main class="popup">
    <header class="head" data-tauri-drag-region>
      <span class="brand" data-tauri-drag-region>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3z" />
        </svg>
        翻译
      </span>
      <button class="icon-btn close" title="关闭 (Esc)" @mousedown.stop @click="closePopup">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>

    <div v-if="sourceText" class="source" :title="sourceText">{{ sourceText }}</div>

    <div class="result" @contextmenu="showContextMenu">
      <div v-if="loading" class="skeleton"><i /><i /><i /></div>
      <div v-else-if="errorMsg" class="error"><b>!</b><span>{{ errorMsg }}</span></div>
      <div v-else class="result-text">{{ resultText }}</div>
    </div>

    <div v-if="vocabInfo && !loading" class="vocab-tag">
      📒 {{ vocabInfo.isNew ? "已加入生词本" : `生词本里已有,第 ${vocabInfo.count} 次查询` }}
    </div>

    <footer class="foot">
      <button class="btn-primary small" :disabled="!resultText" @click="copy(resultText)">
        {{ copied ? "已复制 ✓" : "复制" }}
      </button>
    </footer>
  </main>
</template>

<style scoped>
/* 窗口透明,卡片四周留 10px 给投影(和 Rust 端 POPUP_MARGIN 对应) */
.popup {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 20px);
  margin: 10px;
  padding: 10px 12px 12px;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: pop-in 0.16s ease-out;
}
@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  flex-shrink: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-text);
}
.brand svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
}
.head .icon-btn {
  width: 24px;
  height: 24px;
}

.source {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.result {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 10px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
}
.result-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.error {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}
.error b {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
}

.vocab-tag {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--accent-text);
}

.foot {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}
.btn-primary.small {
  padding: 5px 14px;
  font-size: 12px;
}
</style>
