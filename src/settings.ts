import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  apiKey: string;
  toggleShortcut: string;
  quickTranslateShortcut: string;
  // "auto" = 中文译英文、其他语言译中文;否则是 translate.ts 里 LANGS 的语言代码
  targetLang: string;
  model: string;
  // 翻译领域,见 translate.ts 里的 DOMAINS
  domain: string;
  // 在任何程序里选中文字后,单独按一下 Ctrl 键自动弹出译文
  ctrlTapTranslate: boolean;
  // 术语表:指定"某个词必须译成什么"
  glossary: { src: string; dst: string }[];
  // 每天定时提醒复习生词(桌宠冒泡),时间格式 HH:MM
  reminderEnabled: boolean;
  reminderTime: string;
}

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

// 保存后 Rust 侧会立刻用新值重新注册全局快捷键,所以这里不需要提示用户重启应用。
// 快捷键不合法或被占用时 Rust 会回滚并抛出错误,调用方要把错误信息显示给用户。
export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>("save_settings", { settings });
}

// 主面板切换目标语言时只改这一项,不重新注册快捷键
export function setTargetLang(lang: string): Promise<void> {
  return invoke<void>("set_target_lang", { lang });
}

// 主面板切换翻译领域时只改这一项
export function setDomain(domain: string): Promise<void> {
  return invoke<void>("set_domain", { domain });
}

// 开机自启以系统里的启动项为准,不存在设置文件里
export const autostartGet = () => invoke<boolean>("autostart_get");
export const autostartSet = (enabled: boolean) => invoke<void>("autostart_set", { enabled });
