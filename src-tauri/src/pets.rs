//! 桌宠形象库:用户上传的自定义形象。
//!
//! 图片的抠背景、切帧、对齐都在前端(Canvas)做完,这里只负责存取:
//! 每个形象一个 JSON 文件(app_config_dir/pets/<id>.json),帧以 PNG data URL 的形式存放,
//! 不需要额外的图片编解码依赖。"当前用哪个形象"单独记在 pets/active.txt,
//! 空文件/不存在表示用内置形象。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const MAX_FRAMES: usize = 16;
/// 单帧 data URL 的最大长度(约 1.5MB),防止误传巨大图片撑爆配置目录
const MAX_FRAME_LEN: usize = 2_000_000;
const PNG_PREFIX: &str = "data:image/png;base64,";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetData {
    pub id: String,
    pub name: String,
    /// 走路动画的播放帧率(只有一帧时用不到)
    pub fps: f64,
    /// 帧图片(PNG data URL),统一尺寸、脚底对齐
    pub frames: Vec<String>,
}

/// 列表里只要名字和缩略图,不必把所有帧都传过去
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSummary {
    pub id: String,
    pub name: String,
    pub frame_count: usize,
    pub thumb: String,
}

fn pets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("pets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// id 会拼进文件路径,只允许字母数字,杜绝 "../" 之类的路径穿越
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn read_pet(app: &AppHandle, id: &str) -> Option<PetData> {
    if !valid_id(id) {
        return None;
    }
    let path = pets_dir(app).ok()?.join(format!("{id}.json"));
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn active_id(app: &AppHandle) -> Option<String> {
    let text = fs::read_to_string(pets_dir(app).ok()?.join("active.txt")).ok()?;
    let id = text.trim().to_string();
    valid_id(&id).then_some(id)
}

/// 所有已上传的形象(按上传时间从新到旧)
#[tauri::command]
pub fn pet_list(app: AppHandle) -> Vec<PetSummary> {
    let Ok(dir) = pets_dir(&app) else {
        return Vec::new();
    };
    let mut pets: Vec<PetData> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok())
        .collect();
    // id 是 "p" + 毫秒时间戳,长度相同时字典序即时间序
    pets.sort_by(|a, b| b.id.len().cmp(&a.id.len()).then(b.id.cmp(&a.id)));
    pets.into_iter()
        .filter(|p| !p.frames.is_empty())
        .map(|p| PetSummary {
            frame_count: p.frames.len(),
            thumb: p.frames[0].clone(),
            id: p.id,
            name: p.name,
        })
        .collect()
}

/// 当前使用的自定义形象;None 表示用内置形象(或者选中的形象文件已经被删/损坏)
#[tauri::command]
pub fn pet_get_active(app: AppHandle) -> Option<PetData> {
    read_pet(&app, &active_id(&app)?)
}

/// 当前选中的形象 id,前端设置页用来标出"使用中"
#[tauri::command]
pub fn pet_active_id(app: AppHandle) -> Option<String> {
    active_id(&app).filter(|id| read_pet(&app, id).is_some())
}

#[tauri::command]
pub fn pet_save(app: AppHandle, name: String, fps: f64, frames: Vec<String>) -> Result<String, String> {
    let name = name.trim().chars().take(20).collect::<String>();
    if frames.is_empty() || frames.len() > MAX_FRAMES {
        return Err(format!("帧数需要在 1 到 {MAX_FRAMES} 之间"));
    }
    if frames.iter().any(|f| !f.starts_with(PNG_PREFIX) || f.len() > MAX_FRAME_LEN) {
        return Err("图片格式不对或太大".to_string());
    }
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let id = format!("p{ms}");
    let pet = PetData {
        id: id.clone(),
        name: if name.is_empty() { "我的形象".to_string() } else { name },
        fps: fps.clamp(1.0, 24.0),
        frames,
    };
    let json = serde_json::to_string(&pet).map_err(|e| e.to_string())?;
    fs::write(pets_dir(&app)?.join(format!("{id}.json")), json).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn pet_delete(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("无效的形象".to_string());
    }
    let was_active = active_id(&app).as_deref() == Some(id.as_str());
    let _ = fs::remove_file(pets_dir(&app)?.join(format!("{id}.json")));
    if was_active {
        // 删的正是正在用的:退回内置形象
        pet_set_active(app, None)?;
    }
    Ok(())
}

/// 切换形象。None = 内置形象。切换后通知所有窗口,桌宠窗口收到后会重新加载。
#[tauri::command]
pub fn pet_set_active(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let path = pets_dir(&app)?.join("active.txt");
    match id {
        Some(id) => {
            if read_pet(&app, &id).is_none() {
                return Err("这个形象不存在".to_string());
            }
            fs::write(path, id).map_err(|e| e.to_string())?;
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
    let _ = app.emit("pet-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_pets_directory() {
        assert!(valid_id("p1789876650140"));
        assert!(!valid_id(""));
        assert!(!valid_id("../settings"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a.json"));
    }
}
