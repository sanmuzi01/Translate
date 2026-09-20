import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "../App.vue";
import { callsOf, defaultSettings, notRecorded, route } from "./helpers";

function setup(extra: Record<string, unknown> = {}) {
  route({
    get_settings: defaultSettings,
    translate_text: (a: Record<string, unknown>) => `译:${a.text}`,
    vocab_record: notRecorded,
    vocab_list: [],
    set_target_lang: undefined,
    set_domain: undefined,
    save_settings: undefined,
    autostart_get: false,
    autostart_set: undefined,
    ...extra,
  });
  return mount(App, { attachTo: document.body });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function type(w: ReturnType<typeof mount>, text: string) {
  const ta = w.find("textarea.source");
  await ta.setValue(text);
  await ta.trigger("input");
}

describe("主翻译面板", () => {
  it("初始显示输入框和占位提示,复制按钮不可点", async () => {
    const w = setup();
    await flushPromises();
    expect(w.find("textarea.source").exists()).toBe(true);
    expect(w.text()).toContain("译文会显示在这里");
    expect(w.find(".footer .btn-primary").attributes("disabled")).toBeDefined();
  });

  it("输入后等停顿 600ms 才翻译,并显示译文", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "hello");
    vi.advanceTimersByTime(500);
    expect(callsOf("translate_text")).toHaveLength(0); // 还在防抖
    vi.advanceTimersByTime(150);
    await flushPromises();
    expect(callsOf("translate_text")).toEqual([{ text: "hello" }]);
    expect(w.find(".result-text").text()).toBe("译:hello");
  });

  it("连续输入只发一次请求", async () => {
    const w = setup();
    await flushPromises();
    for (const s of ["h", "he", "hel", "hell", "hello"]) {
      await type(w, s);
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(700);
    await flushPromises();
    expect(callsOf("translate_text")).toEqual([{ text: "hello" }]);
  });

  it("Ctrl+Enter 立即翻译", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "hello");
    await w.find("textarea.source").trigger("keydown", { key: "Enter", ctrlKey: true });
    await flushPromises();
    expect(callsOf("translate_text")).toHaveLength(1);
  });

  it("接口报错时显示红色错误提示", async () => {
    const w = setup({
      translate_text: () => {
        throw "API Key 无效或已失效,请在设置里检查";
      },
    });
    await flushPromises();
    await type(w, "hello");
    vi.advanceTimersByTime(700);
    await flushPromises();
    expect(w.find(".error").text()).toContain("API Key 无效");
  });

  it("清空按钮清掉原文和译文", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "hello");
    vi.advanceTimersByTime(700);
    await flushPromises();
    await w.find(".clear-btn").trigger("click");
    expect((w.find("textarea.source").element as HTMLTextAreaElement).value).toBe("");
    expect(w.text()).toContain("译文会显示在这里");
  });

  it("切换目标语言:保存选择并重新翻译已有原文", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "hello");
    vi.advanceTimersByTime(700);
    await flushPromises();
    await w.find("select.lang-select:not(.domain-select)").setValue("ja");
    await flushPromises();
    expect(callsOf("set_target_lang")).toEqual([{ lang: "ja" }]);
    expect(callsOf("translate_text")).toHaveLength(2);
  });

  it("切换翻译领域:保存并重新翻译", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "driver");
    vi.advanceTimersByTime(700);
    await flushPromises();
    await w.find("select.domain-select").setValue("tech");
    await flushPromises();
    expect(callsOf("set_domain")).toEqual([{ domain: "tech" }]);
    expect(callsOf("translate_text")).toHaveLength(2);
  });

  it("按 Esc 收起窗口", async () => {
    setup();
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(getCurrentWindow().hide).toHaveBeenCalled();
  });

  it("整句英文翻译后出现「提取生词」按钮;单个单词不出现", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "The company implemented a strategy");
    vi.advanceTimersByTime(700);
    await flushPromises();
    expect(w.text()).toContain("提取生词");
    await type(w, "resilient");
    vi.advanceTimersByTime(700);
    await flushPromises();
    expect(w.text()).not.toContain("提取生词");
  });
});

describe("历史", () => {
  it("翻译过的内容出现在历史里,点击可恢复", async () => {
    const w = setup();
    await flushPromises();
    await type(w, "hello");
    vi.advanceTimersByTime(700);
    await flushPromises();
    await w.find('button[title="历史"]').trigger("click");
    expect(w.find(".history-item").text()).toContain("hello");
    await w.find(".history-item").trigger("click");
    await flushPromises();
    expect((w.find("textarea.source").element as HTMLTextAreaElement).value).toBe("hello");
    expect(w.find(".result-text").text()).toBe("译:hello");
  });

  it("没有记录时显示空状态", async () => {
    const w = setup();
    await flushPromises();
    await w.find('button[title="历史"]').trigger("click");
    expect(w.text()).toContain("还没有翻译记录");
  });
});

describe("设置", () => {
  async function openSettings(w: ReturnType<typeof mount>) {
    await w.find('button[title="设置"]').trigger("click");
    await flushPromises();
  }

  it("打开时读取已保存的设置", async () => {
    const w = setup();
    await flushPromises();
    await openSettings(w);
    const inputs = w.findAll("input.field-input").map((i) => (i.element as HTMLInputElement).value);
    expect(inputs).toContain("Alt+Q");
    expect(inputs).toContain("Alt+C");
  });

  it("保存:提交表单内容,成功后提示", async () => {
    const w = setup();
    await flushPromises();
    await openSettings(w);
    await w.find('input[placeholder="Alt+Q"]').setValue("Alt+W");
    await w.find(".footer .btn-primary").trigger("click");
    await flushPromises();
    const saved = callsOf("save_settings")[0].settings as typeof defaultSettings;
    expect(saved.toggleShortcut).toBe("Alt+W");
    expect(w.find(".msg").text()).toContain("已保存");
  });

  it("快捷键被占用等保存失败时,显示后端给的原因", async () => {
    const w = setup({
      save_settings: () => {
        throw "快捷键无法注册(格式不对或已被其他程序占用): xxx";
      },
    });
    await flushPromises();
    await openSettings(w);
    await w.find(".footer .btn-primary").trigger("click");
    await flushPromises();
    expect(w.find(".msg.bad").text()).toContain("快捷键无法注册");
  });

  it("术语表:可以添加、填写、删除条目", async () => {
    const w = setup();
    await flushPromises();
    await openSettings(w);
    expect(w.findAll(".gloss-row")).toHaveLength(0);
    await w.findAll("button").find((b) => b.text().includes("添加术语"))!.trigger("click");
    expect(w.findAll(".gloss-row")).toHaveLength(1);
    const [src, dst] = w.findAll(".gloss-row input");
    await src.setValue("Acme Cloud");
    await dst.setValue("阿克米云");
    await w.find(".footer .btn-primary").trigger("click");
    await flushPromises();
    const saved = callsOf("save_settings")[0].settings as typeof defaultSettings;
    expect(saved.glossary).toEqual([{ src: "Acme Cloud", dst: "阿克米云" }]);
    await w.find(".gloss-del").trigger("click");
    expect(w.findAll(".gloss-row")).toHaveLength(0);
  });

  it("开机自启:只在改动时才调用系统设置", async () => {
    const w = setup({ autostart_get: false });
    await flushPromises();
    await openSettings(w);
    await w.find(".footer .btn-primary").trigger("click");
    await flushPromises();
    expect(callsOf("autostart_set")).toHaveLength(0);
    const box = w
      .findAll("label.check-row input[type=checkbox]")
      .find((c) => c.element.parentElement!.textContent!.includes("开机"))!;
    await box.setValue(true);
    await w.find(".footer .btn-primary").trigger("click");
    await flushPromises();
    expect(callsOf("autostart_set")).toEqual([{ enabled: true }]);
  });

  it("复制诊断信息", async () => {
    const w = setup({ diagnostics: "软件版本: 1.0.0", copy_text: undefined });
    await flushPromises();
    await openSettings(w);
    await w.findAll("button").find((b) => b.text().includes("复制诊断信息"))!.trigger("click");
    await flushPromises();
    expect(callsOf("copy_text")).toEqual([{ text: "软件版本: 1.0.0" }]);
  });
});
