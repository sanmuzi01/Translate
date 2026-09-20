<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCopy } from "./translate";
import {
  dayKey,
  speak,
  vocabDelete,
  vocabExportCsv,
  vocabList,
  vocabReview,
  vocabSetMastered,
  type VocabEntry,
} from "./vocab";

const emit = defineEmits<{ (e: "back"): void }>();

const entries = ref<VocabEntry[]>([]);
const tab = ref<"review" | "list">("review");
const { copied, copy } = useCopy();

async function reload() {
  try {
    entries.value = await vocabList();
  } catch {
    entries.value = [];
  }
}

// 新词的音标、例句是后台补全的,补完后 Rust 会发这个事件,列表跟着刷新
let unlisten: UnlistenFn | undefined;
onMounted(async () => {
  await reload();
  unlisten = await listen("vocab-updated", reload);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  unlisten?.();
  window.removeEventListener("keydown", onKey);
});

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
const today = () => dayKey(Date.now());

const stats = computed(() => {
  const t = today();
  const now = Date.now();
  let todayNew = 0;
  let due = 0;
  let mastered = 0;
  for (const e of entries.value) {
    if (dayKey(e.firstAt) === t) todayNew++;
    if (e.mastered) mastered++;
    else if (e.nextReview <= now) due++;
  }
  return { total: entries.value.length, todayNew, due, mastered };
});

// ---------------------------------------------------------------------------
// 复习:一轮 = 一个队列。答"没记住"的词本轮会再出现一次
// ---------------------------------------------------------------------------
const queue = ref<number[]>([]);
const cursor = ref(0);
const revealed = ref(false);
const retried = new Set<number>();
const sessionTotal = ref(0);
const sessionRemembered = ref(0);
const sessionStarted = ref(false);

function startSession(extra = false) {
  const now = Date.now();
  let pool: VocabEntry[];
  if (extra) {
    // 没有到期的词也想多背几个:挑最常查、还没掌握的
    pool = entries.value.filter((e) => !e.mastered).sort((a, b) => b.count - a.count).slice(0, 10);
  } else {
    pool = entries.value
      .filter((e) => !e.mastered && e.nextReview <= now)
      .sort((a, b) => b.count - a.count || a.level - b.level)
      .slice(0, 30);
  }
  queue.value = pool.map((e) => e.id);
  cursor.value = 0;
  revealed.value = false;
  retried.clear();
  sessionTotal.value = pool.length;
  sessionRemembered.value = 0;
  sessionStarted.value = true;
}

const current = computed(() => {
  const id = queue.value[cursor.value];
  return id === undefined ? undefined : entries.value.find((e) => e.id === id);
});
const finished = computed(() => sessionStarted.value && cursor.value >= queue.value.length);

async function answer(remembered: boolean) {
  const e = current.value;
  if (!e) return;
  try {
    await vocabReview(e.id, remembered);
  } catch {
    // 记录失败也别卡住复习流程
  }
  if (remembered) sessionRemembered.value++;
  else if (!retried.has(e.id)) {
    retried.add(e.id);
    queue.value.push(e.id); // 没记住的词放到队尾,本轮再考一次
  }
  cursor.value++;
  revealed.value = false;
  await reload();
}

function onKey(ev: KeyboardEvent) {
  if (tab.value !== "review" || !current.value) return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
  if (ev.key === " " || ev.key === "Enter") {
    ev.preventDefault();
    if (!revealed.value) revealed.value = true;
  } else if (revealed.value && ev.key === "ArrowLeft") {
    answer(false);
  } else if (revealed.value && ev.key === "ArrowRight") {
    answer(true);
  } else if (ev.key === "p" || ev.key === "P") {
    speak(current.value.word);
  }
}

// ---------------------------------------------------------------------------
// 词库
// ---------------------------------------------------------------------------
const search = ref("");
const filter = ref<"all" | "today" | "hot" | "learning" | "mastered">("all");
const sort = ref<"count" | "recent" | "new">("count");
const expandedId = ref<number | null>(null);
const confirmDeleteId = ref<number | null>(null);

const FILTERS = [
  { k: "all", label: "全部" },
  { k: "today", label: "今日" },
  { k: "hot", label: "高频" },
  { k: "learning", label: "学习中" },
  { k: "mastered", label: "已掌握" },
] as const;

const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  const t = today();
  let list = entries.value.filter((e) => {
    if (q && !e.word.toLowerCase().includes(q) && !e.meaning.toLowerCase().includes(q)) return false;
    switch (filter.value) {
      case "today":
        return dayKey(e.lastAt) === t;
      case "hot":
        return e.count >= 3;
      case "learning":
        return !e.mastered;
      case "mastered":
        return e.mastered;
      default:
        return true;
    }
  });
  list = [...list];
  if (sort.value === "count") list.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  else if (sort.value === "recent") list.sort((a, b) => b.lastAt - a.lastAt);
  else list.sort((a, b) => b.firstAt - a.firstAt);
  return list;
});

function fmtDay(ms: number): string {
  const k = dayKey(ms);
  return k === today() ? "今天" : k.slice(5);
}

async function toggleMastered(e: VocabEntry) {
  await vocabSetMastered(e.id, !e.mastered);
  await reload();
}

async function remove(e: VocabEntry) {
  if (confirmDeleteId.value !== e.id) {
    confirmDeleteId.value = e.id; // 第一次点只是"待确认",防止手滑删词
    setTimeout(() => {
      if (confirmDeleteId.value === e.id) confirmDeleteId.value = null;
    }, 2500);
    return;
  }
  confirmDeleteId.value = null;
  await vocabDelete(e.id);
  await reload();
}

// ---------------------------------------------------------------------------
// 整理 / 导出
// ---------------------------------------------------------------------------
const exportMsg = ref("");

function line(e: VocabEntry): string {
  const head = [e.word, e.phonetic, e.pos].filter(Boolean).join("  ");
  return `${head}  ${e.meaning}${e.count > 1 ? `  (查过 ${e.count} 次)` : ""}`;
}

// 复制今天查过的词:按高频优先,一行一个,方便粘到笔记里
function copyToday() {
  const t = today();
  const list = entries.value
    .filter((e) => dayKey(e.lastAt) === t)
    .sort((a, b) => b.count - a.count);
  if (list.length === 0) {
    exportMsg.value = "今天还没有查过词";
    return;
  }
  copy(`${t} 词汇整理(${list.length} 个)\n\n${list.map(line).join("\n")}`);
  exportMsg.value = "";
}

async function exportCsv() {
  exportMsg.value = "";
  try {
    const path = await vocabExportCsv();
    exportMsg.value = `已导出到桌面:${path.split("\\").pop()}`;
  } catch (e) {
    exportMsg.value = typeof e === "string" ? e : "导出失败";
  }
}
</script>

<template>
  <div class="vocab">
    <!-- 顶部统计 -->
    <div class="stats">
      <div class="stat">
        <b>{{ stats.total }}</b>
        <span>生词</span>
      </div>
      <div class="stat">
        <b>{{ stats.todayNew }}</b>
        <span>今日新增</span>
      </div>
      <div class="stat" :class="{ hot: stats.due > 0 }">
        <b>{{ stats.due }}</b>
        <span>待复习</span>
      </div>
      <div class="stat">
        <b>{{ stats.mastered }}</b>
        <span>已掌握</span>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'review' }" @click="tab = 'review'">
        复习<i v-if="stats.due" class="dot">{{ stats.due }}</i>
      </button>
      <button :class="{ on: tab === 'list' }" @click="tab = 'list'">词库</button>
    </div>

    <!-- 复习 -->
    <section v-if="tab === 'review'" class="review">
      <!-- 还没开始 / 已结束 -->
      <div v-if="!sessionStarted || finished" class="center">
        <template v-if="finished">
          <div class="big">🎉</div>
          <p class="title">这一轮完成了</p>
          <p class="sub">共 {{ sessionTotal }} 个词,答对 {{ sessionRemembered }} 次</p>
        </template>
        <template v-else-if="entries.length === 0">
          <div class="big">📒</div>
          <p class="title">生词本还是空的</p>
          <p class="sub">在翻译面板里查单词或短语,会自动记到这里;查得越多的词越排在前面。</p>
        </template>
        <template v-else>
          <div class="big">{{ stats.due > 0 ? "📚" : "✅" }}</div>
          <p class="title">{{ stats.due > 0 ? `今天有 ${stats.due} 个词要复习` : "今天的复习都做完了" }}</p>
          <p class="sub">
            {{ stats.due > 0 ? "按查询次数从高到低,一轮最多 30 个。" : "想多背几个,可以再练最常查的 10 个词。" }}
          </p>
        </template>
        <div class="row-btns">
          <button v-if="stats.due > 0" class="btn-primary" @click="startSession(false)">
            {{ finished ? "再来一轮" : "开始复习" }}
          </button>
          <button
            v-if="entries.some((e) => !e.mastered)"
            :class="stats.due > 0 ? 'btn-ghost' : 'btn-primary'"
            @click="startSession(true)"
          >
            多背 10 个高频词
          </button>
        </div>
      </div>

      <!-- 卡片 -->
      <div v-else-if="current" class="card-wrap">
        <div class="progress">
          <div class="bar"><i :style="{ width: (cursor / Math.max(queue.length, 1)) * 100 + '%' }" /></div>
          <span>{{ cursor + 1 }} / {{ queue.length }}</span>
        </div>
        <div class="flash" @click="revealed = true">
          <div class="w">{{ current.word }}</div>
          <div class="ph">
            <span v-if="current.phonetic">{{ current.phonetic }}</span>
            <button class="speak" title="朗读 (P)" @click.stop="speak(current.word)">🔊</button>
          </div>
          <template v-if="revealed">
            <div class="mean">
              <em v-if="current.pos">{{ current.pos }}</em>
              {{ current.meaning }}
            </div>
            <div v-if="current.example" class="ex">
              {{ current.example }}
              <span v-if="current.exampleZh">{{ current.exampleZh }}</span>
            </div>
            <div class="meta">查过 {{ current.count }} 次</div>
          </template>
          <div v-else class="tap">点击或按空格显示释义</div>
        </div>
        <div v-if="revealed" class="answers">
          <button class="no" @click="answer(false)">没记住 <small>←</small></button>
          <button class="yes" @click="answer(true)">记住了 <small>→</small></button>
        </div>
      </div>
    </section>

    <!-- 词库 -->
    <section v-else class="list-tab">
      <input v-model="search" class="search" placeholder="搜索单词或释义" />
      <div class="filters">
        <button v-for="f in FILTERS" :key="f.k" :class="{ on: filter === f.k }" @click="filter = f.k">
          {{ f.label }}
        </button>
        <select v-model="sort" class="sort">
          <option value="count">高频优先</option>
          <option value="recent">最近查询</option>
          <option value="new">最新加入</option>
        </select>
      </div>

      <div class="words">
        <div v-if="shown.length === 0" class="empty">
          {{ entries.length === 0 ? "还没有生词,去查几个单词吧" : "没有符合条件的词" }}
        </div>
        <div v-for="e in shown" :key="e.id" class="word" :class="{ done: e.mastered }">
          <div class="line" @click="expandedId = expandedId === e.id ? null : e.id">
            <div class="main">
              <span class="wd">{{ e.word }}</span>
              <span v-if="e.phonetic" class="ph2">{{ e.phonetic }}</span>
              <span v-if="e.count > 1" class="cnt" :class="{ hi: e.count >= 3 }">×{{ e.count }}</span>
            </div>
            <div class="mn"><em v-if="e.pos">{{ e.pos }}</em>{{ e.meaning }}</div>
          </div>
          <div class="acts">
            <button title="朗读" @click="speak(e.word)">🔊</button>
            <button :title="e.mastered ? '取消已掌握' : '标记已掌握'" @click="toggleMastered(e)">
              {{ e.mastered ? "↩" : "✓" }}
            </button>
            <button :class="{ warn: confirmDeleteId === e.id }" title="删除" @click="remove(e)">
              {{ confirmDeleteId === e.id ? "确认?" : "🗑" }}
            </button>
          </div>
          <div v-if="expandedId === e.id" class="detail">
            <p v-if="e.example" class="ex2">
              {{ e.example }}<br /><span>{{ e.exampleZh }}</span>
            </p>
            <p class="dm">
              首次查询 {{ fmtDay(e.firstAt) }} · 最近 {{ fmtDay(e.lastAt) }} · 复习 {{ e.reviews }} 次
              · {{ e.mastered ? "已掌握" : `等级 ${e.level}` }}
            </p>
          </div>
        </div>
      </div>

      <div class="export">
        <button class="btn-ghost" @click="copyToday">{{ copied ? "已复制 ✓" : "复制今日词汇" }}</button>
        <button class="btn-ghost" :disabled="entries.length === 0" @click="exportCsv">导出 CSV 到桌面</button>
      </div>
      <p v-if="exportMsg" class="export-msg">{{ exportMsg }}</p>
    </section>

    <footer class="foot">
      <button class="btn-ghost" @click="emit('back')">返回</button>
    </footer>
  </div>
</template>

<style scoped>
.vocab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 统计 */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  border-radius: 12px;
  background: var(--bg-soft);
}
.stat b {
  font-size: 18px;
  line-height: 1.2;
}
.stat span {
  font-size: 11px;
  color: var(--muted);
}
.stat.hot {
  background: var(--accent-soft);
}
.stat.hot b {
  color: var(--accent-text);
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  background: var(--bg-soft);
}
.tabs button {
  flex: 1;
  border: none;
  border-radius: 999px;
  padding: 6px 0;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
}
.tabs button.on {
  background: var(--bg);
  color: var(--accent-text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(30, 40, 90, 0.15);
}
.dot {
  margin-left: 5px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-style: normal;
}

section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 复习 */
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 0 12px;
}
.big {
  font-size: 40px;
}
.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.row-btns {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
  justify-content: center;
}

.card-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.bar {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.25s;
}
.flash {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  border-radius: 14px;
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
  text-align: center;
  cursor: pointer;
  user-select: none;
}
.w {
  font-size: 30px;
  font-weight: 700;
  word-break: break-word;
}
.ph {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 14px;
}
.speak {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
}
.mean {
  font-size: 17px;
  line-height: 1.5;
}
.mean em,
.mn em {
  margin-right: 6px;
  color: var(--accent-text);
  font-size: 12px;
  font-style: normal;
}
.ex {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.ex span {
  display: block;
  color: var(--muted);
}
.meta {
  font-size: 11.5px;
  color: var(--muted);
}
.tap {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--muted);
}
.answers {
  display: flex;
  gap: 10px;
}
.answers button {
  flex: 1;
  padding: 10px 0;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.answers small {
  opacity: 0.6;
  font-weight: 400;
}
.answers .no {
  background: var(--danger-soft);
  color: var(--danger);
}
.answers .yes {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
}

/* 词库 */
.search {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-soft);
  color: var(--text);
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.search:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--ring);
  background: var(--bg);
}
.filters {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.filters button {
  border: none;
  border-radius: 999px;
  padding: 4px 10px;
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.filters button.on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.sort {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
}
.words {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.empty {
  margin-top: 40px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}
.word {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 7px 8px 7px 12px;
  background: var(--bg);
}
.word.done {
  opacity: 0.6;
}
.line {
  cursor: pointer;
  min-width: 0;
}
.main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.wd {
  font-size: 15px;
  font-weight: 600;
}
.ph2 {
  font-size: 12px;
  color: var(--muted);
}
.cnt {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 11px;
}
.cnt.hi {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}
.mn {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.45;
  word-break: break-word;
}
.acts {
  display: flex;
  gap: 2px;
}
.acts button {
  min-width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}
.acts button:hover {
  background: var(--bg-soft);
  color: var(--text);
}
.acts button.warn {
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 12px;
  padding: 0 6px;
}
.detail {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
.detail p {
  margin: 0 0 4px;
}
.ex2 {
  font-size: 13px;
  line-height: 1.55;
}
.ex2 span {
  color: var(--muted);
}
.dm {
  font-size: 11.5px;
  color: var(--muted);
}
.export {
  display: flex;
  gap: 8px;
}
.export-msg {
  margin: 0;
  font-size: 12px;
  color: var(--accent-text);
}

.foot {
  display: flex;
  justify-content: space-between;
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
</style>
