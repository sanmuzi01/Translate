//! Windows 专用的底层输入辅助:全局键盘/鼠标钩子、前台窗口信息、剪贴板序号。
//! "按一下 Ctrl 翻译选中文字"要在任何程序里感知到 Ctrl 键,普通窗口事件做不到,只能用系统级钩子。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::Instant;

use windows::Win32::Foundation::{CloseHandle, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYUP,
    WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_SYSKEYUP,
};

/// 钩子产生的事件。坐标是屏幕物理像素。
#[derive(Debug, Clone, Copy)]
pub enum InputEvent {
    /// 鼠标按下(任意键):用来判断"点了弹窗以外的地方",收起不会自己失焦的弹窗
    Click { x: i32, y: i32 },
    /// 单独按了一下 Ctrl(按下后没有按别的键、没点鼠标,很快松开)
    CtrlTap,
    /// 按了 Esc
    Esc,
}

static TX: OnceLock<Sender<InputEvent>> = OnceLock::new();

// ---- "单击 Ctrl"的判定状态 ----
// Ctrl 按下期间只要出现别的按键或鼠标点击(Ctrl+C、Ctrl+点击多选……),
// 这次就不是"单击 Ctrl",而是组合键的一部分,不能触发翻译。
static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
static CTRL_DIRTY: AtomicBool = AtomicBool::new(false);
static CTRL_T0: OnceLock<Instant> = OnceLock::new();
static CTRL_DOWN_AT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 按住超过这个时间松开就不算"单击"了(可能是在等别的操作)
const TAP_MAX_MS: u64 = 450;

const VK_ESCAPE: u32 = 0x1B;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;

fn now_ms() -> u64 {
    CTRL_T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn send(ev: InputEvent) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(ev);
    }
}

/// 低级鼠标钩子的回调。系统要求钩子回调在很短时间内返回(超时会被系统跳过甚至摘掉钩子),
/// 所以这里只做"把事件丢进通道"这一件事,真正的处理在另一个线程里慢慢做。
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        if matches!(wparam.0 as u32, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN) {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            CTRL_DIRTY.store(true, Ordering::Relaxed);
            send(InputEvent::Click { x: info.pt.x, y: info.pt.y });
        }
    }
    // 永远把事件继续传给下一个钩子/目标程序:我们只是旁观,绝不拦截用户的输入
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        // 程序自己模拟出来的按键(比如我们为了复制发的 Ctrl+Insert)不能算用户按的
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let vk = info.vkCode;
            let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
            if vk == VK_LCONTROL || vk == VK_RCONTROL {
                if !up {
                    // 按住不放时系统会不停重复发"按下",只有第一次才算开始
                    if !CTRL_DOWN.swap(true, Ordering::Relaxed) {
                        CTRL_DIRTY.store(false, Ordering::Relaxed);
                        CTRL_DOWN_AT_MS.store(now_ms(), Ordering::Relaxed);
                    }
                } else if CTRL_DOWN.swap(false, Ordering::Relaxed)
                    && !CTRL_DIRTY.load(Ordering::Relaxed)
                    && now_ms().saturating_sub(CTRL_DOWN_AT_MS.load(Ordering::Relaxed)) <= TAP_MAX_MS
                {
                    send(InputEvent::CtrlTap);
                }
            } else if !up {
                CTRL_DIRTY.store(true, Ordering::Relaxed);
                if vk == VK_ESCAPE {
                    send(InputEvent::Esc);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// 安装全局键盘和鼠标钩子,并在独立线程里按顺序调用 handler。
/// handler 里可以睡眠/等待(比如等剪贴板),因为它不在钩子线程上。
pub fn start_input_hooks(handler: impl Fn(InputEvent) + Send + 'static) {
    let (tx, rx) = mpsc::channel();
    if TX.set(tx).is_err() {
        return; // 已经启动过
    }
    std::thread::spawn(move || {
        for ev in rx {
            handler(ev);
        }
    });
    // 低级钩子必须由"有消息循环的线程"安装,否则回调永远不会被调用
    std::thread::spawn(|| unsafe {
        if SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0).is_err() {
            eprintln!("安装鼠标钩子失败");
        }
        if SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0).is_err() {
            eprintln!("安装键盘钩子失败,按 Ctrl 划词翻译不可用");
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    });
}

/// 剪贴板内容每变化一次序号就 +1。用它判断"刚才那次复制到底有没有发生",
/// 比"先清空剪贴板再看有没有内容"安全得多 —— 不会破坏用户剪贴板里的图片/文件/富文本。
pub fn clipboard_sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

/// 前台窗口所属进程的 (进程 ID, 可执行文件名小写)。
pub fn foreground_process() -> Option<(u32, String)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return Some((pid, String::new()));
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = path.rsplit('\\').next().unwrap_or("").to_lowercase();
        Some((pid, name))
    }
}

/// 等到 Alt/Shift/Ctrl/Win 这些修饰键都被用户松开(最多等 max_ms 毫秒)。
/// 用快捷键(比如 Alt+C)触发划词时,用户的手指此刻通常还压着修饰键;
/// 这时模拟"复制"发出的按键会和用户还没松开的键混在一起,目标程序收不到正常的 Ctrl+C。
pub fn wait_modifiers_released(max_ms: u64) {
    const VKS: [i32; 5] = [0x10, 0x11, 0x12, 0x5B, 0x5C]; // Shift Ctrl Alt LWin RWin
    let start = Instant::now();
    while start.elapsed().as_millis() < max_ms as u128 {
        // 最高位为 1 表示此刻物理上按着
        let down = VKS.iter().any(|&vk| unsafe { GetAsyncKeyState(vk) } < 0);
        if !down {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}
