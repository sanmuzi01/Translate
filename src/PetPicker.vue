<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import {
  defaultImportOptions,
  loadImageFile,
  petActiveId,
  petDelete,
  petList,
  petSave,
  petSetActive,
  processImage,
  type ImportOptions,
  type PetSummary,
} from "./petImport";

const emit = defineEmits<{ (e: "back"): void }>();

const pets = ref<PetSummary[]>([]);
const activeId = ref<string | null>(null);
const msg = ref("");
const msgBad = ref(false);
const confirmDeleteId = ref<string | null>(null);

function say(text: string, bad = false) {
  msg.value = text;
  msgBad.value = bad;
}
const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "操作失败");

async function reload() {
  try {
    pets.value = await petList();
    activeId.value = await petActiveId();
  } catch (e) {
    say(errText(e), true);
  }
}
onMounted(reload);

async function choose(id: string | null) {
  if (activeId.value === id) return;
  try {
    await petSetActive(id);
    activeId.value = id;
    say("已切换,桌宠会在一秒内换上新形象");
  } catch (e) {
    say(errText(e), true);
  }
}

async function remove(p: PetSummary) {
  if (confirmDeleteId.value !== p.id) {
    confirmDeleteId.value = p.id; // 第一次点只是"待确认",防止手滑删除
    setTimeout(() => {
      if (confirmDeleteId.value === p.id) confirmDeleteId.value = null;
    }, 2500);
    return;
  }
  confirmDeleteId.value = null;
  try {
    await petDelete(p.id);
    await reload();
    say("已删除");
  } catch (e) {
    say(errText(e), true);
  }
}

// ---------------------------------------------------------------------------
// 上传新形象
// ---------------------------------------------------------------------------
const fileEl = ref<HTMLInputElement>();
const source = ref<HTMLImageElement | null>(null);
const opt = ref<ImportOptions>(defaultImportOptions());
const preview = ref<string[]>([]);
const removedBg = ref(false);
const name = ref("");
const fps = ref(9);
const saving = ref(false);
const MAX_FILE = 15 * 1024 * 1024;

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许再次选同一个文件
  if (!file) return;
  if (file.size > MAX_FILE) {
    say("图片太大了(超过 15MB),请压缩后再传", true);
    return;
  }
  try {
    source.value = await loadImageFile(file);
    opt.value = defaultImportOptions();
    name.value = file.name.replace(/\.[^.]+$/, "").slice(0, 20);
    say("");
    refresh();
  } catch (err) {
    source.value = null;
    say(errText(err), true);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function refresh() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!source.value) return;
    const r = processImage(source.value, opt.value);
    preview.value = r.frames;
    removedBg.value = r.removedBg;
    if (r.frames.length === 0) say("没有找到角色,试试调小“背景容差”,或关闭“自动去除背景”", true);
    else if (msgBad.value) say("");
  }, 150);
}
watch(opt, refresh, { deep: true });

function cancelImport() {
  source.value = null;
  preview.value = [];
}

async function save() {
  if (!preview.value.length) return;
  saving.value = true;
  try {
    const id = await petSave(name.value, fps.value, preview.value);
    await petSetActive(id);
    cancelImport();
    await reload();
    say("已保存并切换为新形象");
  } catch (e) {
    say(errText(e), true);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="picker">
    <!-- 新形象的处理界面 -->
    <template v-if="source">
      <div class="preview" :class="{ empty: !preview.length }">
        <img v-for="(f, i) in preview.slice(0, 6)" :key="i" :src="f" class="pv" alt="" />
        <span v-if="preview.length > 6" class="more">+{{ preview.length - 6 }}</span>
        <span v-if="!preview.length" class="none">没有识别到角色</span>
      </div>

      <div class="form">
        <label class="row">
          <span>名字</span>
          <input v-model="name" class="txt" maxlength="20" placeholder="给它起个名字" />
        </label>

        <label class="check">
          <input v-model="opt.removeBg" type="checkbox" />
          <span>自动去除背景<small>(图片本身带透明背景时会自动跳过)</small></span>
        </label>
        <label v-if="opt.removeBg" class="row">
          <span>背景容差</span>
          <input v-model.number="opt.tolerance" type="range" min="5" max="100" />
          <em>{{ opt.tolerance }}</em>
        </label>

        <div class="row">
          <span>动作帧网格</span>
          <input v-model.number="opt.cols" class="num" type="number" min="1" max="8" />
          <span class="x">列 ×</span>
          <input v-model.number="opt.rows" class="num" type="number" min="1" max="8" />
          <span class="x">行</span>
        </div>
        <p class="hint">
          一张图就填 1×1:桌宠会用程序动作让它弹跳、摇摆、伸缩。
          如果是走路精灵图(多个姿势排成网格),按实际列数行数填写,会按帧播放。
        </p>
        <label v-if="preview.length > 1" class="row">
          <span>播放速度</span>
          <input v-model.number="fps" type="range" min="3" max="16" />
          <em>{{ fps }} 帧/秒</em>
        </label>

        <label class="check">
          <input v-model="opt.facingLeft" type="checkbox" />
          <span>原图里角色朝左<small>(会镜像成朝右,走路方向才对)</small></span>
        </label>
      </div>

      <div v-if="msg" class="msg" :class="{ bad: msgBad }">{{ msg }}</div>
      <footer class="foot">
        <button class="btn-ghost" @click="cancelImport">取消</button>
        <button class="btn-primary" :disabled="!preview.length || saving" @click="save">
          {{ saving ? "保存中…" : "保存并使用" }}
        </button>
      </footer>
    </template>

    <!-- 形象列表 -->
    <template v-else>
      <div class="grid">
        <button class="card" :class="{ on: activeId === null }" @click="choose(null)">
          <img src="/frames/idle/1.png" class="th" alt="" />
          <span class="nm">默认形象</span>
          <i v-if="activeId === null" class="tick">使用中</i>
        </button>

        <div v-for="p in pets" :key="p.id" class="card wrap" :class="{ on: activeId === p.id }">
          <button class="inner" @click="choose(p.id)">
            <img :src="p.thumb" class="th" alt="" />
            <span class="nm">{{ p.name }}</span>
          </button>
          <i v-if="activeId === p.id" class="tick">使用中</i>
          <button class="del" :class="{ warn: confirmDeleteId === p.id }" title="删除" @click="remove(p)">
            {{ confirmDeleteId === p.id ? "确认?" : "✕" }}
          </button>
        </div>

        <button class="card add" @click="fileEl?.click()">
          <span class="plus">＋</span>
          <span class="nm">上传新形象</span>
        </button>
      </div>
      <p class="hint">支持 PNG / JPG / WebP。背景透明的 PNG 效果最好;有纯色背景也会自动去掉。</p>
      <div v-if="msg" class="msg" :class="{ bad: msgBad }">{{ msg }}</div>
      <footer class="foot">
        <button class="btn-ghost" @click="emit('back')">返回</button>
      </footer>
    </template>

    <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onFile" />
  </div>
</template>

<style scoped>
.picker {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 6px 6px;
  border: 1.5px solid var(--line);
  border-radius: 14px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
}
.card:hover {
  background: var(--bg-soft);
}
.card.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.card.wrap {
  padding: 0;
  cursor: default;
}
.inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 8px 6px 6px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.th {
  width: 72px;
  height: 72px;
  object-fit: contain;
}
.nm {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text-2);
}
.tick {
  position: absolute;
  top: 5px;
  left: 5px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  font-style: normal;
}
.del {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 22px;
  height: 22px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
.del:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.del.warn {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 0 6px;
}
.card.add {
  border-style: dashed;
  justify-content: center;
  min-height: 104px;
  color: var(--accent-text);
}
.plus {
  font-size: 26px;
  line-height: 1;
}

.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--muted);
}
.msg {
  padding: 7px 10px;
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

/* 预览:棋盘格底,能看出背景到底抠干净没有 */
.preview {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 4px;
  min-height: 130px;
  padding: 8px;
  border-radius: 14px;
  background-color: #eef0f6;
  background-image: conic-gradient(#dfe2ec 25%, transparent 0 50%, #dfe2ec 0 75%, transparent 0);
  background-size: 16px 16px;
  overflow: hidden;
}
.preview.empty {
  align-items: center;
}
.pv {
  width: 110px;
  height: 110px;
  object-fit: contain;
}
.preview:has(.pv:nth-child(2)) .pv {
  width: 64px;
  height: 64px;
}
.more,
.none {
  align-self: center;
  font-size: 12px;
  color: var(--text-2);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}
.row > span:first-child {
  flex-shrink: 0;
  width: 78px;
}
.row input[type="range"] {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}
.row em {
  flex-shrink: 0;
  min-width: 52px;
  font-style: normal;
  color: var(--text);
}
.txt,
.num {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-soft);
  color: var(--text);
  padding: 6px 9px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}
.txt {
  flex: 1;
  min-width: 0;
}
.num {
  width: 52px;
}
.txt:focus,
.num:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--ring);
}
.x {
  color: var(--muted);
}
.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text);
  cursor: pointer;
}
.check input {
  margin-top: 3px;
  accent-color: var(--accent);
}
.check small {
  margin-left: 4px;
  color: var(--muted);
  font-size: 11.5px;
}

.foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
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
.btn-ghost:hover {
  background: var(--bg-soft);
}
</style>
