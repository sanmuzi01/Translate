import { createApp } from "vue";
import { invoke } from "@tauri-apps/api/core";
import App from "./App.vue";
import Popup from "./Popup.vue";
import Ball from "./Ball.vue";
import "./theme.css";

// 主窗口、划词翻译弹窗、悬浮球三个窗口共用同一份前端产物,靠 URL 里的
// hash 片段区分身份(Rust 端创建对应窗口时会把地址设成 index.html#/popup
// 或 index.html#/ball),不引入路由库,改动也最小。
const hash = window.location.hash;
const RootComponent = hash.startsWith("#/popup") ? Popup : hash.startsWith("#/ball") ? Ball : App;

createApp(RootComponent).mount("#app");

// 网页里的报错用户看不到,转发一份到本地日志,出问题时才有线索(不含翻译内容)
function report(level: "error" | "warn", msg: string) {
  invoke("log_frontend", { level, msg }).catch(() => {});
}
window.addEventListener("error", (e) => report("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  report("error", `未处理的异常: ${r instanceof Error ? r.message : String(r)}`);
});
