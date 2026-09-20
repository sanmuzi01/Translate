import type { PetRig } from "./petRig";
import { invoke } from "@tauri-apps/api/core";
import { createSpriteRig, loadFrames, type CustomPet } from "./spriteRig";

// 宠物渲染的统一入口:
//   用户上传的自定义形象 / 内置逐帧素材(public/frames/manifest.json)-> 播放画好的帧,没有任何变形
//   没有素材                                 -> 退回单张图的网格变形动画
// 注意要在创建渲染器之前就决定用哪种:同一个 canvas 只能拿到一种绘图上下文(2D 或 WebGL)。
export async function createPet(
  canvas: HTMLCanvasElement,
  fallbackTextureUrl: string,
  cssW: number,
  cssH: number,
): Promise<PetRig> {
  // 用户选了自定义形象就用它;读取失败或素材损坏就退回内置形象,宠物不会因此消失
  let custom: CustomPet | null = null;
  try {
    custom = await invoke<CustomPet | null>("pet_get_active");
  } catch {
    custom = null;
  }
  const frames = (custom && (await loadFrames(custom))) || (await loadFrames());
  if (frames) return createSpriteRig(canvas, frames, cssW, cssH);
  // 只有一套素材都没有时才会用到网格变形渲染器(带 three.js,体积大),所以按需加载
  const { createPetRig } = await import("./petRig");
  return createPetRig(canvas, fallbackTextureUrl, cssW, cssH);
}
