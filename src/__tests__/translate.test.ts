import { describe, expect, it } from "vitest";
import { addHistory, clearHistory, loadHistory, useCopy, useTranslator } from "../translate";
import { callsOf, notRecorded, route } from "./helpers";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useTranslator", () => {
  it("翻译成功:显示译文、写入历史、通知生词本", async () => {
    route({ translate_text: "你好", vocab_record: notRecorded });
    const t = useTranslator();
    await t.run("hello");
    expect(t.resultText.value).toBe("你好");
    expect(t.errorMsg.value).toBe("");
    expect(loadHistory()[0]).toMatchObject({ src: "hello", res: "你好" });
    expect(callsOf("vocab_record")).toEqual([{ src: "hello", res: "你好" }]);
  });

  it("空文本不请求接口,并清空译文", async () => {
    route({ translate_text: "x" });
    const t = useTranslator();
    t.resultText.value = "旧译文";
    await t.run("   ");
    expect(callsOf("translate_text")).toHaveLength(0);
    expect(t.resultText.value).toBe("");
  });

  it("接口报错:显示错误、清掉译文", async () => {
    route({
      translate_text: () => {
        throw "未配置 API Key,请先点右上角 ⚙ 填写";
      },
    });
    const t = useTranslator();
    t.resultText.value = "旧";
    await t.run("hello");
    expect(t.errorMsg.value).toContain("API Key");
    expect(t.resultText.value).toBe("");
    expect(t.loading.value).toBe(false);
  });

  it("先发出的请求后返回时,不能覆盖新请求的结果", async () => {
    const resolvers: Record<string, (v: string) => void> = {};
    route({
      translate_text: (a: Record<string, unknown>) =>
        new Promise<string>((resolve) => (resolvers[a.text as string] = resolve)),
      vocab_record: notRecorded,
    });
    const t = useTranslator();
    const first = t.run("one");
    const second = t.run("two");
    resolvers["two"]("二");
    await second;
    resolvers["one"]("一"); // 旧请求晚到
    await first;
    expect(t.resultText.value).toBe("二");
    expect(loadHistory().map((h) => h.src)).toEqual(["two"]);
  });

  it("cancel 会让正在进行的请求作废", async () => {
    let resolve!: (v: string) => void;
    route({ translate_text: () => new Promise<string>((r) => (resolve = r)), vocab_record: notRecorded });
    const t = useTranslator();
    const p = t.run("hello");
    t.cancel();
    resolve("你好");
    await p;
    expect(t.resultText.value).toBe("");
    expect(t.loading.value).toBe(false);
  });

  it("查词被记进生词本后,给出提示信息", async () => {
    route({
      translate_text: "有韧性的",
      vocab_record: { recorded: true, isNew: true, count: 1, word: "resilient" },
    });
    const t = useTranslator();
    await t.run("resilient");
    await flush();
    expect(t.vocabInfo.value).toEqual({ isNew: true, count: 1 });
    t.cancel();
    expect(t.vocabInfo.value).toBeNull();
  });
});

describe("翻译历史", () => {
  it("相同原文只保留最新一条并排到最前", () => {
    addHistory("a", "甲");
    addHistory("b", "乙");
    addHistory("a", "甲2");
    const h = loadHistory();
    expect(h.map((x) => x.src)).toEqual(["a", "b"]);
    expect(h[0].res).toBe("甲2");
  });

  it("最多保留 50 条", () => {
    for (let i = 0; i < 60; i++) addHistory(`w${i}`, `译${i}`);
    expect(loadHistory()).toHaveLength(50);
    expect(loadHistory()[0].src).toBe("w59");
  });

  it("忽略空内容;可以清空;存储里是坏数据时不崩", () => {
    addHistory("", "x");
    addHistory("x", "");
    expect(loadHistory()).toHaveLength(0);
    addHistory("a", "甲");
    clearHistory();
    expect(loadHistory()).toHaveLength(0);
    localStorage.setItem("translator.history", "{坏的");
    expect(loadHistory()).toEqual([]);
  });
});

describe("useCopy", () => {
  it("复制后短暂显示已复制", async () => {
    route({ copy_text: undefined });
    const c = useCopy();
    await c.copy("译文");
    expect(callsOf("copy_text")).toEqual([{ text: "译文" }]);
    expect(c.copied.value).toBe(true);
  });

  it("空文本不复制", async () => {
    route({ copy_text: undefined });
    const c = useCopy();
    await c.copy("");
    expect(callsOf("copy_text")).toHaveLength(0);
  });
});
