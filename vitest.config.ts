import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 界面测试:用 jsdom 模拟浏览器,Tauri 的接口全部换成假的(见 src/__tests__/setup.ts),
// 这样不需要真的启动桌面程序就能测点击、输入、切换视图这些交互。
export default defineConfig({
  plugins: [vue({ template: { transformAssetUrls: false } })],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
