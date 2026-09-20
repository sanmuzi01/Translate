<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  DOMAINS,
  LANGS,
  clearHistory,
  loadHistory,
  useCopy,
  useTranslator,
  type HistoryItem,
} from "./translate";
import ResizeGrips from "./ResizeGrips.vue";
import VocabView from "./VocabView.vue";
import PetPicker from "./PetPicker.vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { vocabAddMany, vocabExtract, type ExtractedWord } from "./vocab";
import { autostartGet, autostartSet, getSettings, saveSettings, setDomain, setTargetLang, type AppSettings } from "./settings";

const { sourceText, resultText, loading, errorMsg, vocabInfo, run, cancel } = useTranslator();
const { copied, copy } = useCopy();
const appWindow = getCurrentWindow();
const sourceEl = ref<HTMLTextAreaElement>();

// 五个视图:翻译 / 生词本 / 历史 / 设置 / 桌宠形象
const view = ref<"translate" | "vocab" | "history" | "settings" | "pets">("translate");

// 应用常驻在系统托盘、靠全局快捷键唤出,所以关闭按钮只隐藏窗口而不是真正
// 关闭/退出进程 —— 否则托盘图标和全局快捷键都会跟着失效。真正退出走托盘菜单的“退出”。
function closeWindow() {
  appWindow.hide();
}

// ---- 目标语言 ----
const targetLang = ref("auto");

async function onLangChange() {
  try {
    await setTargetLang(targetLang.value);
  } catch {
    // 写配置失败不影响这次翻译
  }
  // 换了目标语言,已有的原文要按新语言重新翻一遍
  partialSrc.value = "";
  if (sourceText.value.trim()) run(sourceText.value);
}

// ---- 翻译领域 ----
const domain = ref("general");

async function onDomainChange() {
  try {
    await setDomain(domain.value);
  } catch {
    // 写配置失败不影响这次翻译
  }
  partialSrc.value = "";
  if (sourceText.value.trim()) run(sourceText.value);
}

// ---- 设置面板 ----
const settingsForm = ref<AppSettings>({
  apiKey: "",
  toggleShortcut: "Alt+Q",
  quickTranslateShortcut: "Alt+C",
  targetLang: "auto",
  model: "deepseek-chat",
  domain: "general",
  ctrlTapTranslate: true,
  glossary: [],
  reminderEnabled: true,
  reminderTime: "21:00",
});
const autostart = ref(false);
let autostartInitial = false;
const settingsSaving = ref(false);
const settingsMsg = ref("");
const settingsIsError = ref(false);

async function openSettings() {
  settingsMsg.value = "";
  try {
    settingsForm.value = await getSettings();
  } catch (e) {
    // 读取失败就用表单里的默认值,不阻塞用户填写
  }
  try {
    autostart.value = autostartInitial = await autostartGet();
  } catch {
    // 读不到就当没开
  }
  view.value = "settings";
}

async function submitSettings() {
  settingsSaving.value = true;
  settingsMsg.value = "";
  settingsIsError.value = false;
  try {
    await saveSettings(settingsForm.value);
    if (autostart.value !== autostartInitial) {
      await autostartSet(autostart.value);
      autostartInitial = autostart.value;
    }
    settingsMsg.value = "已保存,快捷键已立即生效";
  } catch (e) {
    settingsIsError.value = true;
    settingsMsg.value = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  } finally {
    settingsSaving.value = false;
  }
}

function backToTranslate() {
  view.value = "translate";
  nextTick(() => sourceEl.value?.focus());
}

// ---- 从整句里提取生词 ----
// 查单词会自动记进生词本;整句翻译时,可以让 AI 挑出值得背的词,由用户一键加入。
const extracting = ref(false);
const extracted = ref<ExtractedWord[] | null>(null);
const extractMsg = ref("");

const canExtract = computed(() => {
  const s = sourceText.value.trim();
  return (
    !!resultText.value &&
    /[A-Za-z]/.test(s) &&
    !/[一-鿿]/.test(s) &&
    s.split(/\s+/).length >= 4
  );
});

// 原文一变,上一次提取的结果就作废
watch(sourceText, () => {
  extracted.value = null;
  extractMsg.value = "";
});

async function extractWords() {
  extracting.value = true;
  extractMsg.value = "";
  try {
    const words = await vocabExtract(sourceText.value);
    extracted.value = words;
    if (words.length === 0) extractMsg.value = "这句话里没有特别值得背的词";
  } catch (e) {
    extracted.value = null;
    extractMsg.value = typeof e === "string" ? e : "提取失败,请重试";
  } finally {
    extracting.value = false;
  }
}

async function addExtracted() {
  if (!extracted.value?.length) return;
  try {
    const n = await vocabAddMany(extracted.value);
    extractMsg.value = n > 0 ? `已加入 ${n} 个新词到生词本` : "这些词都已经在生词本里了(查询次数已 +1)";
    extracted.value = null;
  } catch {
    extractMsg.value = "加入失败,请重试";
  }
}

// ---- 历史 ----
const history = ref<HistoryItem[]>([]);

function openHistory() {
  history.value = loadHistory();
  view.value = "history";
}

function restoreHistory(item: HistoryItem) {
  sourceText.value = item.src;
  resultText.value = item.res;
  errorMsg.value = "";
  partialSrc.value = "";
  backToTranslate();
}

function onClearHistory() {
  clearHistory();
  history.value = [];
}

// ---- 主翻译面板 ----
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
// 不为空表示当前显示的是"选中部分"的译文(右键菜单里的"翻译选中内容"),值是那段选中的原文
const partialSrc = ref("");

// 边输入边翻译,停顿 600ms 才发请求,避免每敲一个字就调一次接口(既慢又费钱)
function onInput() {
  errorMsg.value = "";
  partialSrc.value = "";
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!sourceText.value.trim()) {
    cancel();
    resultText.value = "";
    return;
  }
  debounceTimer = setTimeout(() => run(sourceText.value), 600);
}

// Ctrl+Enter:不等停顿,立刻翻译
function translateNow() {
  if (debounceTimer) clearTimeout(debounceTimer);
  partialSrc.value = "";
  run(sourceText.value);
}

function clearSource() {
  if (debounceTimer) clearTimeout(debounceTimer);
  cancel();
  sourceText.value = "";
  resultText.value = "";
  errorMsg.value = "";
  partialSrc.value = "";
  sourceEl.value?.focus();
}

// ---- 右键菜单:和系统的"剪切/复制/粘贴"放在一起,多一项"翻译选中内容" ----
function selectedIn(area: "source" | "result"): string {
  if (area === "source") {
    const el = sourceEl.value;
    return el ? el.value.substring(el.selectionStart, el.selectionEnd).trim() : "";
  }
  return (window.getSelection()?.toString() ?? "").trim();
}

function translateSelection(text: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  partialSrc.value = text;
  run(text);
}

async function showContextMenu(e: MouseEvent, area: "source" | "result") {
  e.preventDefault();
  const selected = selectedIn(area);
  const items = [];
  if (area === "source") {
    items.push(await PredefinedMenuItem.new({ item: "Cut", text: "剪切" }));
  }
  items.push(
    await PredefinedMenuItem.new({ item: "Copy", text: "复制" }),
    await PredefinedMenuItem.new({ item: "SelectAll", text: "全选" }),
  );
  if (area === "source") {
    items.splice(2, 0, await PredefinedMenuItem.new({ item: "Paste", text: "粘贴" }));
  }
  items.push(
    await PredefinedMenuItem.new({ item: "Separator" }),
    await MenuItem.new({
      text: selected ? "翻译选中内容" : "翻译选中内容(请先选中文字)",
      enabled: !!selected,
      action: () => translateSelection(selected),
    }),
  );
  const menu = await Menu.new({ items });
  await menu.popup();
}

// Esc 收起窗口(和弹窗、系统里大多数浮层的习惯一致)
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closeWindow();
}

// ---- 窗口大小:用户拖边缘调整,停手 400ms 后记住,下次启动恢复 ----
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function onResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // innerWidth/innerHeight 是 CSS 像素,正好等于窗口的逻辑尺寸
    invoke("save_main_size", { width: window.innerWidth, height: window.innerHeight }).catch(() => {});
  }, 400);
}

let unlistenFocus: (() => void) | undefined;
let unlistenView: UnlistenFn | undefined;

onMounted(async () => {
  try {
    const st = await getSettings();
    targetLang.value = st.targetLang || "auto";
    domain.value = st.domain || "general";
  } catch {
    // 用默认值
  }
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onResize);
  // 桌宠右键菜单"更换桌宠形象"会让主窗口直接跳到对应视图
  unlistenView = await listen<string>("open-view", (e) => {
    if (e.payload === "pets" || e.payload === "vocab") view.value = e.payload;
  });
  // 每次窗口被唤出(快捷键/悬浮球/托盘)都直接聚焦输入框并选中旧内容:
  // 用户按下快捷键后可以马上粘贴或输入,不用再用鼠标点一下输入框。
  unlistenFocus = await appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused && view.value === "translate") {
      nextTick(() => {
        sourceEl.value?.focus();
        sourceEl.value?.select();
      });
    }
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onResize);
  unlistenFocus?.();
  unlistenView?.();
});
</script>

<template>
  <ResizeGrips />
  <main class="panel">
    <header class="titlebar" data-tauri-drag-region>
      <div v-if="view === 'translate'" class="lang-wrap" @mousedown.stop>
        <svg class="globe" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3z" />
        </svg>
        <select v-model="targetLang" class="lang-select" title="目标语言" @change="onLangChange">
          <option v-for="l in LANGS" :key="l.code" :value="l.code">
            {{ l.code === "auto" ? l.label : "译成 " + l.label }}
          </option>
        </select>
      </div>
      <select
        v-if="view === 'translate'"
        v-model="domain"
        class="lang-select domain-select"
        :class="{ active: domain !== 'general' }"
        title="翻译领域:同一个词在不同领域译法不同"
        @mousedown.stop
        @change="onDomainChange"
      >
        <option v-for="d in DOMAINS" :key="d.code" :value="d.code">{{ d.label }}</option>
      </select>
      <span v-if="view !== 'translate'" class="view-title" data-tauri-drag-region>
        {{ { vocab: "生词本", history: "翻译历史", settings: "设置", pets: "桌宠形象" }[view] }}
      </span>
      <span class="spacer" data-tauri-drag-region />
      <button class="icon-btn" title="生词本" @mousedown.stop @click="view = 'vocab'">
        <svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z" /><path d="M8 7h7" /></svg>
      </button>
      <button class="icon-btn" title="历史" @mousedown.stop @click="openHistory">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </button>
      <button class="icon-btn" title="设置" @mousedown.stop @click="openSettings">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      <button class="icon-btn close" title="关闭 (Esc)" @mousedown.stop @click="closeWindow">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>

    <!-- 翻译 -->
    <template v-if="view === 'translate'">
      <section class="card source-card">
        <textarea
          ref="sourceEl"
          v-model="sourceText"
          class="source"
          placeholder="输入或粘贴文字,自动翻译…"
          spellcheck="false"
          @input="onInput"
          @keydown.ctrl.enter.prevent="translateNow"
          @contextmenu="showContextMenu($event, 'source')"
        />
        <button v-if="sourceText" class="clear-btn" title="清空" @click="clearSource">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
        <span v-if="sourceText" class="count">{{ sourceText.length }}</span>
      </section>

      <section class="card result-card" @contextmenu="showContextMenu($event, 'result')">
        <div v-if="partialSrc" class="partial-tag" @contextmenu.stop>
          <span class="partial-label">选中部分</span>
          <span class="partial-src">{{ partialSrc }}</span>
          <button class="partial-full" @click="translateNow">翻译全文</button>
        </div>
        <div v-if="loading" class="skeleton"><i /><i /><i /></div>
        <div v-else-if="errorMsg" class="error"><b>!</b><span>{{ errorMsg }}</span></div>
        <div v-else-if="resultText" class="result-text">{{ resultText }}</div>
        <div v-else class="placeholder">译文会显示在这里</div>
        <div v-if="vocabInfo && !loading" class="vocab-tag">
          📒 {{ vocabInfo.isNew ? "已加入生词本" : `生词本里已有,这是第 ${vocabInfo.count} 次查询` }}
        </div>
      </section>

      <section v-if="extracted && extracted.length" class="card extract-card">
        <div class="ex-head">
          <span>值得背的词</span>
          <button class="ex-add" @click="addExtracted">全部加入生词本</button>
          <button class="ex-x" title="收起" @click="extracted = null">✕</button>
        </div>
        <div v-for="w in extracted" :key="w.word" class="ex-row">
          <b>{{ w.word }}</b>
          <span v-if="w.phonetic" class="ex-ph">{{ w.phonetic }}</span>
          <span class="ex-mn"><em v-if="w.pos">{{ w.pos }}</em>{{ w.meaning }}</span>
        </div>
      </section>
      <div v-if="extractMsg" class="extract-msg">{{ extractMsg }}</div>

      <footer class="footer">
        <span v-if="!canExtract" class="tip">Ctrl+Enter 立即翻译 · Esc 关闭</span>
        <button v-else class="btn-ghost" :disabled="extracting" @click="extractWords">
          {{ extracting ? "提取中…" : "提取生词" }}
        </button>
        <button class="btn-primary" :disabled="!resultText" @click="copy(resultText)">
          {{ copied ? "已复制 ✓" : "复制译文" }}
        </button>
      </footer>
    </template>

    <!-- 桌宠形象 -->
    <PetPicker v-else-if="view === 'pets'" @back="openSettings" />

    <!-- 生词本 -->
    <VocabView v-else-if="view === 'vocab'" @back="backToTranslate" />

    <!-- 历史 -->
    <template v-else-if="view === 'history'">
      <div class="history-list">
        <div v-if="history.length === 0" class="placeholder empty">还没有翻译记录</div>
        <button v-for="h in history" :key="h.ts" class="history-item" @click="restoreHistory(h)">
          <span class="h-src">{{ h.src }}</span>
          <span class="h-res">{{ h.res }}</span>
        </button>
      </div>
      <footer class="footer">
        <button class="btn-ghost" @click="backToTranslate">返回</button>
        <button class="btn-ghost" :disabled="history.length === 0" @click="onClearHistory">清空历史</button>
      </footer>
    </template>

    <!-- 设置 -->
    <template v-else>
      <div class="settings-form">
        <label class="field-label">DeepSeek API Key</label>
        <input
          v-model="settingsForm.apiKey"
          type="password"
          class="field-input"
          placeholder="sk-..."
          autocomplete="off"
        />

        <label class="field-label">显示/隐藏主窗口快捷键</label>
        <input v-model="settingsForm.toggleShortcut" class="field-input" placeholder="Alt+Q" />

        <label class="field-label">划词翻译快捷键(先在其他程序里选中文字,再按它)</label>
        <input
          v-model="settingsForm.quickTranslateShortcut"
          class="field-input"
          placeholder="Alt+C"
        />

        <label class="check-row">
          <input v-model="settingsForm.ctrlTapTranslate" type="checkbox" />
          <span>选中文字后,单独按一下 Ctrl 键翻译(在任何程序里都可用)</span>
        </label>

        <label class="check-row">
          <input v-model="autostart" type="checkbox" />
          <span>开机自动启动(启动后只显示桌宠和托盘图标)</span>
        </label>
        <label class="check-row">
          <input v-model="settingsForm.reminderEnabled" type="checkbox" />
          <span>每天提醒复习生词</span>
          <input
            v-model="settingsForm.reminderTime"
            type="time"
            class="field-input time-input"
            :disabled="!settingsForm.reminderEnabled"
          />
        </label>

        <label class="field-label">桌宠</label>
        <button class="btn-ghost pet-entry" @click="view = 'pets'">更换 / 上传桌宠形象…</button>

        <label class="field-label">模型</label>
        <input v-model="settingsForm.model" class="field-input" placeholder="deepseek-chat" />

        <label class="field-label">术语表(原文里出现这些词时,一律按你指定的译法翻译)</label>
        <div v-for="(g, i) in settingsForm.glossary" :key="i" class="gloss-row">
          <input v-model="g.src" class="field-input" placeholder="原词,如 Acme Cloud" />
          <span class="arrow">→</span>
          <input v-model="g.dst" class="field-input" placeholder="译法,如 阿克米云" />
          <button class="gloss-del" title="删除这一条" @click="settingsForm.glossary.splice(i, 1)">✕</button>
        </div>
        <button class="btn-ghost pet-entry" @click="settingsForm.glossary.push({ src: '', dst: '' })">
          ＋ 添加术语
        </button>

        <div v-if="settingsMsg" class="msg" :class="{ bad: settingsIsError }">
          {{ settingsMsg }}
        </div>
      </div>
      <footer class="footer">
        <button class="btn-ghost" @click="backToTranslate">返回</button>
        <button class="btn-primary" :disabled="settingsSaving" @click="submitSettings">
          {{ settingsSaving ? "保存中…" : "保存" }}
        </button>
      </footer>
    </template>
  </main>
</template>

<style scoped>
/* 窗口本身是透明的,面板四周留 10px 边距给投影;圆角和阴影都画在面板上 */
.panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 20px);
  margin: 10px;
  padding: 12px;
  gap: 10px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  overflow: hidden;
}

.titlebar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  flex-shrink: 0;
}

.spacer {
  flex: 1;
  align-self: stretch;
}

.view-title {
  font-size: 14px;
  font-weight: 600;
  padding-left: 4px;
}

/* 目标语言:胶囊形下拉 */
.lang-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.globe {
  position: absolute;
  left: 9px;
  width: 15px;
  height: 15px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.8;
  stroke-linecap: round;
  pointer-events: none;
}
.lang-select {
  appearance: none;
  border: none;
  outline: none;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  padding: 6px 14px 6px 29px;
  cursor: pointer;
}
.domain-select {
  margin-left: 6px;
  padding: 6px 12px;
  background: var(--bg-soft);
  color: var(--text-2);
}
/* 选了具体领域时用强调色,提醒用户当前不是"通用" */
.domain-select.active {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.lang-select:hover {
  filter: brightness(0.97);
}
.lang-select option {
  background: var(--bg);
  color: var(--text);
}

/* 卡片 */
.card {
  position: relative;
  border-radius: 12px;
  min-height: 0;
}

.source-card {
  flex: 1;
  background: var(--bg-soft);
  border: 1px solid transparent;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.source-card:focus-within {
  background: var(--bg);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--ring);
}

.source {
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  padding: 12px 34px 26px 14px;
}
.source::placeholder {
  color: var(--muted);
}

.clear-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--line);
  color: var(--text-2);
  cursor: pointer;
}
.clear-btn:hover {
  background: var(--muted);
  color: #fff;
}
.clear-btn svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
}
.count {
  position: absolute;
  right: 12px;
  bottom: 7px;
  font-size: 11px;
  color: var(--muted);
  pointer-events: none;
}

/* 译文卡片:淡淡的强调色底 + 左侧色条 */
.result-card {
  flex: 1.15;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 12px 14px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
}
.result-text {
  font-size: 15px;
  line-height: 1.65;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  animation: fade-in 0.25s ease;
}
@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.placeholder {
  color: var(--muted);
  font-size: 13.5px;
}
.placeholder.empty {
  text-align: center;
  margin-top: 60px;
}
.error {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--danger);
  font-size: 13.5px;
  line-height: 1.5;
}
.error b {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--danger);
  color: #fff;
  font-size: 12px;
}

.partial-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.partial-label {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
}
.partial-src {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.partial-full {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--accent-text);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.tip {
  font-size: 11.5px;
  color: var(--muted);
}

.btn-ghost {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--bg-soft);
}
.btn-ghost:disabled {
  opacity: 0.4;
  cursor: default;
}

/* 生词本提示 / 提取生词 */
.vocab-tag {
  margin-top: auto;
  align-self: flex-start;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--accent-text);
  font-size: 11.5px;
}
.extract-card {
  flex: none;
  max-height: 34%;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ex-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.ex-head span {
  flex: 1;
}
.ex-add {
  border: none;
  border-radius: 999px;
  padding: 3px 10px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.ex-x {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.ex-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.ex-ph {
  color: var(--muted);
  font-size: 12px;
}
.ex-mn {
  color: var(--text-2);
}
.ex-mn em {
  margin-right: 5px;
  color: var(--accent-text);
  font-size: 11.5px;
  font-style: normal;
}
.extract-msg {
  font-size: 12px;
  color: var(--accent-text);
}

/* 历史 */
.history-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--bg);
  border-radius: 12px;
  padding: 9px 12px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s, border-color 0.12s;
}
.history-item:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.h-src,
.h-res {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.45;
}
.h-src {
  color: var(--muted);
}
.h-res {
  color: var(--text);
}

/* 设置 */
.settings-form {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}
.field-label {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 6px;
}
.field-input {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-soft);
  color: var(--text);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.field-input:focus {
  background: var(--bg);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--ring);
}
.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.5;
  cursor: pointer;
}
.check-row input {
  margin-top: 3px;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.time-input {
  margin-left: auto;
  padding: 3px 8px;
}
.gloss-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.gloss-row .field-input {
  flex: 1;
  min-width: 0;
}
.arrow {
  color: var(--muted);
}
.gloss-del {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 8px;
  width: 26px;
  height: 26px;
}
.gloss-del:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.pet-entry {
  align-self: flex-start;
}
.msg {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12.5px;
  line-height: 1.5;
}
.msg.bad {
  background: var(--danger-soft);
  color: var(--danger);
}
</style>
