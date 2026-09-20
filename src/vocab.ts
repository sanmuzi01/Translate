import { invoke } from "@tauri-apps/api/core";

// 和 Rust 端 vocab.rs 的 VocabEntry 一一对应(camelCase)
export interface VocabEntry {
  id: number;
  word: string;
  meaning: string;
  phonetic: string;
  pos: string;
  example: string;
  exampleZh: string;
  count: number;
  firstAt: number;
  lastAt: number;
  level: number;
  nextReview: number;
  mastered: boolean;
  reviews: number;
}

export interface RecordResult {
  recorded: boolean;
  isNew: boolean;
  count: number;
  word: string;
}

export interface ExtractedWord {
  word: string;
  meaning: string;
  pos: string;
  phonetic: string;
}

// 每次翻译成功后调用:Rust 判断是不是"查词",是就记进生词本
export const vocabRecord = (src: string, res: string) =>
  invoke<RecordResult>("vocab_record", { src, res });

export const vocabList = () => invoke<VocabEntry[]>("vocab_list");
export const vocabDelete = (id: number) => invoke<void>("vocab_delete", { id });
export const vocabSetMastered = (id: number, mastered: boolean) =>
  invoke<void>("vocab_set_mastered", { id, mastered });
export const vocabReview = (id: number, remembered: boolean) =>
  invoke<void>("vocab_review", { id, remembered });
export const vocabExtract = (text: string) => invoke<ExtractedWord[]>("vocab_extract", { text });
export const vocabAddMany = (words: ExtractedWord[]) => invoke<number>("vocab_add_many", { words });
// 导出到桌面,返回文件路径。getTimezoneOffset 是"UTC 减本地"的分钟数,东八区为 -480,所以取反
export const vocabExportCsv = () =>
  invoke<string>("vocab_export_csv", { tzOffsetMin: -new Date().getTimezoneOffset() });

/** 本地日期 "YYYY-MM-DD",用来判断"是不是今天" */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 朗读单词(系统自带的语音合成,不需要联网) */
export function speak(word: string) {
  try {
    const u = new SpeechSynthesisUtterance(word);
    u.lang = "en-US";
    u.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    // 系统没有语音引擎时静默忽略
  }
}
