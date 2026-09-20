import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

type Handler = unknown | ((args: Record<string, unknown>) => unknown);

/** 让 invoke(命令名, 参数) 按表返回结果;值是函数就调用它;抛出的错误会变成 Promise 拒绝。 */
export function route(handlers: Record<string, Handler>) {
  const mock = vi.mocked(invoke);
  mock.mockReset();
  mock.mockImplementation((async (cmd: string, args?: unknown) => {
    if (!(cmd in handlers)) return undefined;
    const h = handlers[cmd];
    return typeof h === "function" ? (h as (a: Record<string, unknown>) => unknown)((args ?? {}) as Record<string, unknown>) : h;
  }) as never);
  return mock;
}

/** 某个命令被调用过几次、每次的参数 */
export function callsOf(cmd: string): Record<string, unknown>[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === cmd)
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

export const defaultSettings = {
  apiKey: "sk-test",
  toggleShortcut: "Alt+Q",
  quickTranslateShortcut: "Alt+C",
  targetLang: "auto",
  model: "deepseek-chat",
  domain: "general",
  ctrlTapTranslate: true,
  glossary: [] as { src: string; dst: string }[],
  reminderEnabled: true,
  reminderTime: "21:00",
};

export const notRecorded = { recorded: false, isNew: false, count: 0, word: "" };
