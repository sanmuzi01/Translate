//! 本地日志。别人用软件遇到问题时,你没法看到他的屏幕,只能靠日志和诊断信息定位。
//! 日志只写在本机(app_log_dir/app.log),从不上传;超过 1MB 自动轮转成 app.log.1,
//! 所以不会无限增长。隐私:只记录"发生了什么"和数字(字数、状态码、进程名),
//! 绝不记录翻译的文本内容和 API Key。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1_000_000;

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_PATH.set(dir.join("app.log"));
}

pub fn path() -> Option<PathBuf> {
    LOG_PATH.get().cloned()
}

/// 本地时间 "YYYY-MM-DD HH:MM:SS"
fn timestamp() -> String {
    #[cfg(windows)]
    unsafe {
        let t = windows::Win32::System::SystemInformation::GetLocalTime();
        return format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        );
    }
    #[cfg(not(windows))]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("t+{secs}")
    }
}

/// 写一行日志。level: INFO / WARN / ERROR
pub fn write(level: &str, msg: &str) {
    // 同时打到控制台,开发时看得到
    eprintln!("[{level}] {msg}");
    let Some(path) = LOG_PATH.get() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} [{level}] {msg}", timestamp());
    }
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logger::write("INFO", &format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logger::write("WARN", &format!($($arg)*)) };
}
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logger::write("ERROR", &format!($($arg)*)) };
}

/// 程序崩溃(panic)时也写进日志。默认的 panic 信息只会打到看不见的控制台,用户根本看不到。
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知".to_string());
        write("ERROR", &format!("程序崩溃(panic): {payload} @ {location}"));
        default(info);
    }));
}

/// 日志最后 n 行,用于诊断信息
pub fn tail(n: usize) -> String {
    let Some(path) = LOG_PATH.get() else {
        return String::new();
    };
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_of_missing_log_is_empty() {
        // 没有初始化路径时不应 panic
        let _ = tail(10);
    }
}
