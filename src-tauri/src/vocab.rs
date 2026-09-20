//! 生词本:把每天查过的单词/短语自动记下来,统计查询次数(高频词优先),
//! 并用"间隔重复"(莱特纳盒子法)安排复习,方便背诵。
//!
//! 数据存在 app_config_dir/vocab.json。所有读写都在 Rust 侧、同一把锁下完成:
//! 主窗口和划词弹窗是两个独立的网页,如果各自读文件、各自写回,后写的会把先写的覆盖掉。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::{load_settings, AppState};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabEntry {
    pub id: u64,
    /// 要背的词(英文)
    pub word: String,
    /// 中文释义
    #[serde(default)]
    pub meaning: String,
    #[serde(default)]
    pub phonetic: String,
    /// 词性,如 n. / v. / adj.
    #[serde(default)]
    pub pos: String,
    #[serde(default)]
    pub example: String,
    #[serde(default)]
    pub example_zh: String,
    /// 累计查询次数,越高越"高频"
    pub count: u32,
    /// 毫秒时间戳
    pub first_at: i64,
    pub last_at: i64,
    /// 莱特纳盒子等级 0..=6,等级越高复习间隔越长
    #[serde(default)]
    pub level: u8,
    /// 下次该复习的时间(毫秒时间戳);<= 现在 就是"到期"
    #[serde(default)]
    pub next_review: i64,
    #[serde(default)]
    pub mastered: bool,
    /// 累计复习次数
    #[serde(default)]
    pub reviews: u32,
}

#[derive(Default)]
pub struct VocabState {
    entries: Mutex<Option<Vec<VocabEntry>>>,
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 每个等级"答对之后"多久再复习(天)。0 级是新词/刚忘记的词,马上就该复习。
const INTERVAL_DAYS: [i64; 7] = [0, 1, 2, 4, 7, 15, 30];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn vocab_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("vocab.json"))
}

fn load(app: &AppHandle) -> Vec<VocabEntry> {
    let Some(path) = vocab_path(app) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str(&content) {
        Ok(list) => list,
        Err(_) => {
            // 文件坏了:先备份再从空白开始,千万不能直接覆盖 —— 那是用户攒了很久的词
            let _ = fs::copy(&path, path.with_extension("json.bak"));
            Vec::new()
        }
    }
}

fn save(app: &AppHandle, list: &[VocabEntry]) {
    let Some(path) = vocab_path(app) else { return };
    let Ok(json) = serde_json::to_string_pretty(list) else {
        return;
    };
    // 先写临时文件再替换:写到一半断电/崩溃,原文件也不会变成半截
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, json).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// 在锁内读取/修改词库。闭包返回 (结果, 是否修改过);修改过才落盘。
fn with_store<T>(app: &AppHandle, f: impl FnOnce(&mut Vec<VocabEntry>) -> (T, bool)) -> T {
    let state = app.state::<VocabState>();
    let mut guard = state.entries.lock().unwrap();
    if guard.is_none() {
        *guard = Some(load(app));
    }
    let list = guard.as_mut().unwrap();
    let (out, dirty) = f(list);
    if dirty {
        save(app, list);
    }
    out
}

// ---------------------------------------------------------------------------
// 判断一次翻译是不是"查词"
// ---------------------------------------------------------------------------

fn trim_punct(s: &str) -> &str {
    s.trim()
        .trim_matches(|c: char| ".,!?;:。,!?;:\"'“”‘’()()[]".contains(c) || c.is_whitespace())
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

fn has_kana_or_hangul(s: &str) -> bool {
    s.chars().any(|c| {
        ('\u{3040}'..='\u{30ff}').contains(&c) || ('\u{ac00}'..='\u{d7af}').contains(&c)
    })
}

/// 像一个英文单词/短语:含英文字母、不含中日韩文字、最多 3 个词、不像句子
fn latin_word_like(s: &str) -> bool {
    let n = s.chars().count();
    if n == 0 || n > 40 || s.split_whitespace().count() > 3 {
        return false;
    }
    s.chars().any(|c| c.is_ascii_alphabetic())
        && !has_cjk(s)
        && !has_kana_or_hangul(s)
        && !s.contains(|c: char| "。.!?!?;;".contains(c))
}

/// 如果这次翻译是"查词",返回 (要背的英文词, 中文释义)。
/// - 英文词/短语 -> 中文:词是原文,释义是译文
/// - 中文短词 -> 英文:词是译文,释义是原文(想背的是英文那一边)
fn vocab_candidate(src: &str, res: &str) -> Option<(String, String)> {
    let s = trim_punct(src);
    let r = trim_punct(res);
    if s.is_empty() || r.is_empty() {
        return None;
    }
    if latin_word_like(s) && has_cjk(r) {
        return Some((s.to_string(), r.to_string()));
    }
    if has_cjk(s) && !has_kana_or_hangul(s) && s.chars().count() <= 8 && latin_word_like(r) {
        return Some((r.to_string(), s.to_string()));
    }
    None
}

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    /// 这次翻译是不是被当作"查词"记进了生词本
    pub recorded: bool,
    pub is_new: bool,
    pub count: u32,
    pub word: String,
}

/// 追加释义:同一个词有多个意思时用"；"连起来,但别无限增长
fn merge_meaning(old: &str, new: &str) -> String {
    if old.is_empty() {
        return new.to_string();
    }
    if old.contains(new) || old.chars().count() > 60 {
        return old.to_string();
    }
    format!("{old};{new}")
}

/// 每次翻译成功后由前端调用。是查词就记一笔(次数+1),不是就什么都不做。
#[tauri::command]
pub fn vocab_record(app: AppHandle, src: String, res: String) -> RecordResult {
    let Some((word, meaning)) = vocab_candidate(&src, &res) else {
        return RecordResult {
            recorded: false,
            is_new: false,
            count: 0,
            word: String::new(),
        };
    };
    let key = word.to_lowercase();
    let now = now_ms();

    let (result, new_id) = with_store(&app, |list| {
        if let Some(e) = list.iter_mut().find(|e| e.word.to_lowercase() == key) {
            e.count += 1;
            e.last_at = now;
            e.meaning = merge_meaning(&e.meaning, &meaning);
            let r = RecordResult {
                recorded: true,
                is_new: false,
                count: e.count,
                word: e.word.clone(),
            };
            ((r, None), true)
        } else {
            let id = list.iter().map(|e| e.id).max().unwrap_or(0) + 1;
            list.push(VocabEntry {
                id,
                word: word.clone(),
                meaning: meaning.clone(),
                phonetic: String::new(),
                pos: String::new(),
                example: String::new(),
                example_zh: String::new(),
                count: 1,
                first_at: now,
                last_at: now,
                level: 0,
                next_review: now,
                mastered: false,
                reviews: 0,
            });
            let r = RecordResult {
                recorded: true,
                is_new: true,
                count: 1,
                word: word.clone(),
            };
            ((r, Some(id)), true)
        }
    });

    // 新词在后台补全音标、词性和例句,不阻塞翻译结果的显示
    if let Some(id) = new_id {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            enrich(app2, id).await;
        });
    }
    result
}

#[tauri::command]
pub fn vocab_list(app: AppHandle) -> Vec<VocabEntry> {
    with_store(&app, |list| (list.clone(), false))
}

#[tauri::command]
pub fn vocab_delete(app: AppHandle, id: u64) {
    with_store(&app, |list| {
        list.retain(|e| e.id != id);
        ((), true)
    });
}

#[tauri::command]
pub fn vocab_set_mastered(app: AppHandle, id: u64, mastered: bool) {
    with_store(&app, |list| {
        if let Some(e) = list.iter_mut().find(|e| e.id == id) {
            e.mastered = mastered;
            if !mastered {
                // 取消"已掌握":从头开始重新记
                e.level = 0;
                e.next_review = now_ms();
            }
        }
        ((), true)
    });
}

/// 复习一个词:记住了升一级(间隔变长),没记住回到 0 级、10 分钟后再来。
#[tauri::command]
pub fn vocab_review(app: AppHandle, id: u64, remembered: bool) {
    let now = now_ms();
    with_store(&app, |list| {
        if let Some(e) = list.iter_mut().find(|e| e.id == id) {
            e.reviews += 1;
            if remembered {
                if e.level as usize >= INTERVAL_DAYS.len() - 1 {
                    // 已经在最高级还答对了:视为掌握,不再出现在复习里
                    e.mastered = true;
                } else {
                    e.level += 1;
                }
                e.next_review = now + INTERVAL_DAYS[e.level as usize] * DAY_MS;
            } else {
                e.level = 0;
                e.next_review = now + 10 * 60 * 1000;
            }
        }
        ((), true)
    });
}

// ---------------------------------------------------------------------------
// 用 DeepSeek 补全词条 / 从句子里提取生词
// ---------------------------------------------------------------------------

/// 请求 DeepSeek 并要求返回 JSON 对象。返回解析后的 JSON。
async fn chat_json(app: &AppHandle, system: &str, user: &str) -> Result<serde_json::Value, String> {
    let settings = load_settings(app);
    if settings.api_key.trim().is_empty() {
        return Err("未配置 API Key,请先点右上角 ⚙ 填写".to_string());
    }
    let state = app.state::<AppState>();
    let body = serde_json::json!({
        "model": settings.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "response_format": { "type": "json_object" },
        "stream": false
    });
    let res = state
        .http
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "API Key 无效或已失效,请在设置里检查".to_string(),
            402 => "DeepSeek 账户余额不足,请充值后再试".to_string(),
            429 => "请求太频繁了,请稍等几秒再试".to_string(),
            _ => format!("请求失败 ({status})"),
        });
    }
    let data: serde_json::Value = res.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    let content = data["choices"][0]["message"]["content"].as_str().unwrap_or("");
    serde_json::from_str(content).map_err(|_| "返回内容不是有效的 JSON,请重试".to_string())
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").trim().to_string()
}

/// 给一个新词补全音标、词性、例句。失败就算了(不影响使用,下次复习时也不会缺太多)。
async fn enrich(app: AppHandle, id: u64) {
    let Some((word, meaning)) = with_store(&app, |list| {
        (
            list.iter().find(|e| e.id == id).map(|e| (e.word.clone(), e.meaning.clone())),
            false,
        )
    }) else {
        return;
    };
    let system = "You are an English vocabulary tutor for a Chinese learner. \
        Reply with a JSON object with these string fields: \
        \"phonetic\" (IPA in slashes, e.g. /həˈloʊ/; empty for multi-word phrases), \
        \"pos\" (part of speech in short Chinese-textbook form like n. / v. / adj. / adv. / phr.), \
        \"meaning\" (concise Chinese meaning, at most 20 characters, the most common senses), \
        \"example\" (one natural, simple English example sentence using the word), \
        \"example_zh\" (Chinese translation of the example).";
    let user = format!("Word or phrase: {word}\nUser's Chinese gloss (may be partial): {meaning}");
    let Ok(v) = chat_json(&app, system, &user).await else {
        return;
    };
    with_store(&app, |list| {
        if let Some(e) = list.iter_mut().find(|e| e.id == id) {
            e.phonetic = str_field(&v, "phonetic");
            e.pos = str_field(&v, "pos");
            e.example = str_field(&v, "example");
            e.example_zh = str_field(&v, "example_zh");
            let m = str_field(&v, "meaning");
            // 模型给的释义更完整时采用它;查词时用户看到的原始译文仍保留在 count 之外不丢
            if !m.is_empty() {
                e.meaning = m;
            }
        }
        ((), true)
    });
    let _ = app.emit("vocab-updated", id);
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ExtractedWord {
    pub word: String,
    #[serde(default)]
    pub meaning: String,
    #[serde(default)]
    pub pos: String,
    #[serde(default)]
    pub phonetic: String,
}

/// 从一段英文里挑出值得背的词(跳过 the/is 这类最基础的词)。
#[tauri::command]
pub async fn vocab_extract(app: AppHandle, text: String) -> Result<Vec<ExtractedWord>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let system = "You help a Chinese learner build a vocabulary list. \
        From the English text, pick up to 8 words or fixed phrases worth memorizing \
        (skip very basic words like the/is/and, skip proper names). \
        Use the base (dictionary) form. Reply with a JSON object: \
        {\"words\":[{\"word\":\"...\",\"meaning\":\"concise Chinese meaning in this context, at most 15 characters\",\
        \"pos\":\"n./v./adj./adv./phr.\",\"phonetic\":\"/IPA/ or empty\"}]}.";
    let v = chat_json(&app, system, text).await?;
    let words: Vec<ExtractedWord> = serde_json::from_value(v["words"].clone()).unwrap_or_default();
    Ok(words
        .into_iter()
        .filter(|w| latin_word_like(w.word.trim()))
        .take(8)
        .collect())
}

/// 把 vocab_extract 得到的词加入生词本(已存在的词只增加次数)。返回新增的个数。
#[tauri::command]
pub fn vocab_add_many(app: AppHandle, words: Vec<ExtractedWord>) -> u32 {
    let now = now_ms();
    with_store(&app, |list| {
        let mut added = 0;
        for w in words {
            let word = w.word.trim().to_string();
            if word.is_empty() {
                continue;
            }
            let key = word.to_lowercase();
            if let Some(e) = list.iter_mut().find(|e| e.word.to_lowercase() == key) {
                e.count += 1;
                e.last_at = now;
                if e.meaning.is_empty() {
                    e.meaning = w.meaning.clone();
                }
                continue;
            }
            let id = list.iter().map(|e| e.id).max().unwrap_or(0) + 1;
            list.push(VocabEntry {
                id,
                word,
                meaning: w.meaning,
                phonetic: w.phonetic,
                pos: w.pos,
                example: String::new(),
                example_zh: String::new(),
                count: 1,
                first_at: now,
                last_at: now,
                level: 0,
                next_review: now,
                mastered: false,
                reviews: 0,
            });
            added += 1;
        }
        (added, true)
    })
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 毫秒时间戳 -> 本地日期 "YYYY-MM-DD"。tz_offset_min 是本地时区相对 UTC 的分钟数(东八区 = 480)。
/// 不引入 chrono:这里只要日期,用"天数 -> 公历日期"的标准算法就够了。
fn fmt_date(ms: i64, tz_offset_min: i64) -> String {
    let days = (ms / 1000 + tz_offset_min * 60).div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn csv_cell(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// 导出成 CSV 放到桌面(带 BOM,Excel 直接双击打开中文不乱码)。返回文件路径。
#[tauri::command]
pub fn vocab_export_csv(app: AppHandle, tz_offset_min: i64) -> Result<String, String> {
    let list = with_store(&app, |list| (list.clone(), false));
    if list.is_empty() {
        return Err("生词本还是空的".to_string());
    }
    let mut sorted = list;
    sorted.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_at.cmp(&a.last_at)));

    let mut out = String::from("\u{feff}单词,音标,词性,释义,例句,例句翻译,查询次数,首次查询,最近查询,状态\n");
    for e in &sorted {
        let row = [
            csv_cell(&e.word),
            csv_cell(&e.phonetic),
            csv_cell(&e.pos),
            csv_cell(&e.meaning),
            csv_cell(&e.example),
            csv_cell(&e.example_zh),
            e.count.to_string(),
            fmt_date(e.first_at, tz_offset_min),
            fmt_date(e.last_at, tz_offset_min),
            (if e.mastered { "已掌握" } else { "学习中" }).to_string(),
        ];
        out.push_str(&row.join(","));
        out.push('\n');
    }

    let dir = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!("生词本-{}.csv", fmt_date(now_ms(), tz_offset_min)));
    fs::write(&path, out).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_word_to_chinese_is_a_lookup() {
        assert_eq!(
            vocab_candidate("Resilient", "有韧性的"),
            Some(("Resilient".into(), "有韧性的".into()))
        );
        // 短语(3 个词以内)也算
        assert!(vocab_candidate("take off", "起飞").is_some());
    }

    #[test]
    fn chinese_word_to_english_records_the_english_side() {
        assert_eq!(
            vocab_candidate("坚韧", "resilient"),
            Some(("resilient".into(), "坚韧".into()))
        );
    }

    #[test]
    fn sentences_are_not_lookups() {
        assert!(vocab_candidate("The company implemented a strategy.", "公司实施了战略。").is_none());
        assert!(vocab_candidate("this is a very long phrase", "这是一个很长的短语").is_none());
        // 单词后面带标点(用户选中时常带上)也应当算查词
        assert!(vocab_candidate("hello,", "你好").is_some());
        assert!(vocab_candidate("", "").is_none());
    }

    #[test]
    fn japanese_and_korean_are_not_recorded() {
        assert!(vocab_candidate("こんにちは", "你好").is_none());
        assert!(vocab_candidate("안녕", "你好").is_none());
    }

    #[test]
    fn meaning_merge_dedups_and_is_bounded() {
        assert_eq!(merge_meaning("", "a"), "a");
        assert_eq!(merge_meaning("有韧性的", "有韧性的"), "有韧性的");
        assert_eq!(merge_meaning("有韧性的", "能恢复的"), "有韧性的;能恢复的");
        let long = "长".repeat(61);
        assert_eq!(merge_meaning(&long, "新"), long);
    }

    #[test]
    fn date_formatting_handles_timezone_and_leap_days() {
        // 2024-02-29 16:00 UTC = 东八区 2024-03-01
        assert_eq!(fmt_date(1_709_222_400_000, 0), "2024-02-29");
        assert_eq!(fmt_date(1_709_222_400_000, 480), "2024-03-01");
        assert_eq!(fmt_date(0, 0), "1970-01-01");
    }

    #[test]
    fn csv_cells_escape_quotes() {
        assert_eq!(csv_cell("a\"b"), "\"a\"\"b\"");
    }
}
