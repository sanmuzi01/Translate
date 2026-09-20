import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import { vocabRecord } from "./vocab";

// 实际的 DeepSeek HTTP 请求和 API Key 都放在 Rust 后端(见 src-tauri/src/lib.rs 的
// translate_text 命令),前端只负责调用 IPC。这样打包后的前端 JS 产物里不会包含
// 明文 API Key —— 如果直接在前端 fetch,任何人解压安装包都能从 JS 里读到 Key。
export async function translateText(text: string): Promise<string> {
  if (!text.trim()) return "";
  return await invoke<string>("translate_text", { text });
}

// 支持的目标语言。code 要和 Rust 端 lang_name 里的保持一致。
export const LANGS = [
  { code: "auto", label: "自动(中↔外)" },
  { code: "zh", label: "中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
];

// 翻译领域。code 要和 Rust 端 domain_hint 里的保持一致。
// 领域会写进提示词:同一个词在不同领域译法不同(driver:IT 里是"驱动程序",日常里是"司机")。
export const DOMAINS = [
  { code: "general", label: "通用" },
  { code: "tech", label: "技术/IT" },
  { code: "medical", label: "医学" },
  { code: "legal", label: "法律" },
  { code: "business", label: "商务金融" },
  { code: "academic", label: "学术" },
  { code: "daily", label: "日常口语" },
];

// ---------------------------------------------------------------------------
// 翻译状态:主面板和划词弹窗共用同一套逻辑
// ---------------------------------------------------------------------------
export function useTranslator() {
  const sourceText = ref("");
  const resultText = ref("");
  const loading = ref(false);
  const errorMsg = ref("");
  // 这次翻译如果是"查词",记进生词本之后的信息(显示"已加入生词本 / 第 N 次查询")
  const vocabInfo = ref<{ isNew: boolean; count: number } | null>(null);
  // 每次发起翻译就 +1。请求是异步的:用户连续输入时,先发出的请求可能后返回,
  // 如果不检查序号,旧请求的结果会覆盖新请求的结果,界面显示的译文就和原文对不上了。
  let seq = 0;

  async function run(text: string) {
    const id = ++seq;
    errorMsg.value = "";
    vocabInfo.value = null;
    if (!text.trim()) {
      resultText.value = "";
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const result = await translateText(text);
      if (id !== seq) return;
      resultText.value = result;
      addHistory(text, result);
      // 查词就自动记进生词本(不是查词 Rust 会忽略)。失败不影响翻译结果的显示。
      vocabRecord(text, result)
        .then((r) => {
          if (id === seq && r.recorded) vocabInfo.value = { isNew: r.isNew, count: r.count };
        })
        .catch(() => {});
    } catch (e) {
      if (id !== seq) return;
      resultText.value = "";
      errorMsg.value = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    } finally {
      if (id === seq) loading.value = false;
    }
  }

  // 使正在进行的请求作废(比如用户清空了输入框)
  function cancel() {
    seq++;
    loading.value = false;
    vocabInfo.value = null;
  }

  return { sourceText, resultText, loading, errorMsg, vocabInfo, run, cancel };
}

// ---------------------------------------------------------------------------
// 复制到剪贴板 + “已复制”反馈
// ---------------------------------------------------------------------------
export function useCopy() {
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(text: string) {
    if (!text) return;
    try {
      // 走 Rust 侧写剪贴板:划词弹窗是不抢焦点的窗口,浏览器的剪贴板接口在那里会被拒绝
      await invoke("copy_text", { text });
      copied.value = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (copied.value = false), 1400);
    } catch {
      // 剪贴板被系统拒绝时不打扰用户,按钮保持原样即可
    }
  }
  return { copied, copy };
}

// ---------------------------------------------------------------------------
// 翻译历史(存在本地 localStorage,主面板和弹窗同源所以共用)
// ---------------------------------------------------------------------------
export interface HistoryItem {
  src: string;
  res: string;
  ts: number;
}

const HISTORY_KEY = "translator.history";
const HISTORY_MAX = 50;

export function loadHistory(): HistoryItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHistory(list: HistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 存储满了或被禁用:历史只是锦上添花,丢了不影响翻译
  }
}

export function addHistory(src: string, res: string) {
  const s = src.trim();
  if (!s || !res) return;
  // 相同原文只保留最新一条,并移到最前面
  const list = loadHistory().filter((h) => h.src !== s);
  list.unshift({ src: s, res, ts: Date.now() });
  saveHistory(list.slice(0, HISTORY_MAX));
}

export function clearHistory() {
  saveHistory([]);
}
