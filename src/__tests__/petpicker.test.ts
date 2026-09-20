import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import PetPicker from "../PetPicker.vue";
import { defaultImportOptions } from "../petImport";
import { callsOf, route } from "./helpers";

const pets = [
  { id: "p2", name: "小橙", frameCount: 1, thumb: "data:image/png;base64,AAAA" },
  { id: "p1", name: "小蓝", frameCount: 4, thumb: "data:image/png;base64,BBBB" },
];

function setup(active: string | null = null) {
  route({
    pet_list: pets,
    pet_active_id: active,
    pet_set_active: undefined,
    pet_delete: undefined,
  });
  return mount(PetPicker);
}

describe("桌宠形象选择", () => {
  it("显示默认形象和已上传的形象,标出使用中的", async () => {
    const w = setup("p1");
    await flushPromises();
    expect(w.findAll(".card")).toHaveLength(4); // 默认 + 2 个 + 上传
    expect(w.text()).toContain("小橙");
    expect(w.find(".card.on").text()).toContain("小蓝");
    expect(w.find(".card.on .tick").text()).toBe("使用中");
  });

  it("点击形象切换;点默认形象切回内置", async () => {
    const w = setup(null);
    await flushPromises();
    await w.findAll(".card.wrap .inner")[0].trigger("click");
    await flushPromises();
    expect(callsOf("pet_set_active")).toEqual([{ id: "p2" }]);
    await w.findAll(".card")[0].trigger("click");
    await flushPromises();
    // 第一次切换后 activeId 已是 p2,点默认形象应切回内置(id 为 null)
    expect(callsOf("pet_set_active").slice(-1)[0]).toEqual({ id: null });
  });

  it("已经在用的形象再点一下不重复切换", async () => {
    const w = setup("p2");
    await flushPromises();
    await w.findAll(".card.wrap .inner")[0].trigger("click");
    expect(callsOf("pet_set_active")).toHaveLength(0);
  });

  it("删除要点两次才生效", async () => {
    const w = setup();
    await flushPromises();
    const del = () => w.findAll(".del")[0];
    await del().trigger("click");
    expect(callsOf("pet_delete")).toHaveLength(0);
    expect(del().text()).toContain("确认");
    await del().trigger("click");
    await flushPromises();
    expect(callsOf("pet_delete")).toEqual([{ id: "p2" }]);
  });

  it("默认形象没有删除按钮", async () => {
    const w = setup();
    await flushPromises();
    expect(w.findAll(".card")[0].find(".del").exists()).toBe(false);
  });

  it("后端出错时显示错误", async () => {
    route({
      pet_list: pets,
      pet_active_id: null,
      pet_set_active: () => {
        throw "这个形象不存在";
      },
    });
    const w = mount(PetPicker);
    await flushPromises();
    await w.findAll(".card.wrap .inner")[0].trigger("click");
    await flushPromises();
    expect(w.find(".msg.bad").text()).toContain("不存在");
  });
});

describe("上传参数", () => {
  it("默认:1x1、自动去背景、朝右", () => {
    expect(defaultImportOptions()).toMatchObject({ cols: 1, rows: 1, removeBg: true, facingLeft: false });
  });
});
