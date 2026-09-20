import { beforeEach, vi } from "vitest";

// ---- Tauri 接口的替身 ----
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const windowApi = {
  hide: vi.fn(async () => {}),
  startResizeDragging: vi.fn(async () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
};
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
  currentMonitor: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: vi.fn(async () => ({ popup: vi.fn(async () => {}) })) },
  MenuItem: { new: vi.fn(async (o: unknown) => o) },
  PredefinedMenuItem: { new: vi.fn(async (o: unknown) => o) },
}));

beforeEach(() => {
  localStorage.clear();
});
