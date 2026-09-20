import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import VocabView from "../VocabView.vue";
import { dayKey, type VocabEntry } from "../vocab";
import { callsOf, route } from "./helpers";

const NOW = Date.now();
const entry = (o: Partial<VocabEntry>): VocabEntry => ({
  id: 1,
  word: "resilient",
  meaning: "有韧性的",
  phonetic: "/rɪˈzɪliənt/",
  pos: "adj.",
  example: "Kids are resilient.",
  exampleZh: "孩子们很有韧性。",
  count: 3,
  firstAt: NOW,
  lastAt: NOW,
  level: 0,
  nextReview: NOW - 1000,
  mastered: false,
  reviews: 0,
  ...o,
});

let list: VocabEntry[];
function setup() {
  route({
    vocab_list: () => list,
    vocab_review: undefined,
    vocab_delete: undefined,
    vocab_set_mastered: undefined,
  });
  return mount(VocabView);
}

beforeEach(() => {
  list = [
    entry({ id: 1, word: "resilient", count: 5 }),
    entry({ id: 2, word: "volatile", meaning: "易变的", count: 2 }),
    entry({ id: 3, word: "mitigate", mastered: true }),
    entry({ id: 4, word: "future", nextReview: NOW + 86_400_000 }),
  ];
});

describe("dayKey", () => {
  it("按本地日期生成 YYYY-MM-DD", () => {
    expect(dayKey(new Date(2024, 0, 5, 23, 59).getTime())).toBe("2024-01-05");
  });
});

describe("生词本 - 统计与复习", () => {
  it("统计:总数、今日新增、待复习(不含已掌握和未到期)、已掌握", async () => {
    const w = setup();
    await flushPromises();
    const nums = w.findAll(".stat b").map((b) => b.text());
    expect(nums).toEqual(["4", "4", "2", "1"]);
  });

  it("复习流程:先看单词,点击显示释义,答对后调用后端并推进", async () => {
    const w = setup();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("开始复习"))!.trigger("click");
    // 按查询次数从高到低:先出 resilient
    expect(w.find(".flash .w").text()).toBe("resilient");
    expect(w.find(".mean").exists()).toBe(false);
    await w.find(".flash").trigger("click");
    expect(w.find(".mean").text()).toContain("有韧性的");
    await w.find(".answers .yes").trigger("click");
    await flushPromises();
    expect(callsOf("vocab_review")).toEqual([{ id: 1, remembered: true }]);
    expect(w.find(".flash .w").text()).toBe("volatile");
  });

  it("答错的词本轮末尾会再出现一次,再错不会无限重复", async () => {
    const w = setup();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("开始复习"))!.trigger("click");
    const seen: string[] = [];
    for (let i = 0; i < 6 && w.find(".flash").exists(); i++) {
      seen.push(w.find(".flash .w").text());
      await w.find(".flash").trigger("click");
      await w.find(".answers .no").trigger("click");
      await flushPromises();
    }
    expect(seen).toEqual(["resilient", "volatile", "resilient", "volatile"]);
    expect(w.text()).toContain("这一轮完成了");
  });

  it("空生词本给出引导", async () => {
    list = [];
    const w = setup();
    await flushPromises();
    expect(w.text()).toContain("生词本还是空的");
  });
});

describe("生词本 - 词库", () => {
  async function toList(w: ReturnType<typeof mount>) {
    await w.findAll(".tabs button")[1].trigger("click");
  }

  it("按高频排序;搜索;筛选已掌握", async () => {
    const w = setup();
    await flushPromises();
    await toList(w);
    expect(w.findAll(".word .wd")[0].text()).toBe("resilient");
    await w.find(".search").setValue("易变");
    expect(w.findAll(".word")).toHaveLength(1);
    expect(w.find(".word .wd").text()).toBe("volatile");
    await w.find(".search").setValue("");
    await w.findAll(".filters button").find((b) => b.text() === "已掌握")!.trigger("click");
    expect(w.findAll(".word .wd").map((x) => x.text())).toEqual(["mitigate"]);
  });

  it("删除要点两次才生效(防手滑)", async () => {
    const w = setup();
    await flushPromises();
    await toList(w);
    const del = () => w.find('.word .acts button[title="删除"]');
    await del().trigger("click");
    expect(callsOf("vocab_delete")).toHaveLength(0);
    expect(del().text()).toContain("确认");
    await del().trigger("click");
    await flushPromises();
    expect(callsOf("vocab_delete")).toEqual([{ id: 1 }]);
  });

  it("标记已掌握", async () => {
    const w = setup();
    await flushPromises();
    await toList(w);
    await w.find('.word .acts button[title="标记已掌握"]').trigger("click");
    await flushPromises();
    expect(callsOf("vocab_set_mastered")).toEqual([{ id: 1, mastered: true }]);
  });
});
