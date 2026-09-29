//! 「上次关窗时多大」—— 记住它，下次开窗贴回去。
//!
//! # ⚠️★ 这个文件里**没有 `tauri`**，和 [`crate::store`] / [`crate::runtime`] 同一条规矩
//!
//! 2026-09-29，Jonny：「记住客户端窗口调整的大小」。
//!
//! 真正会出错的地方**不在**「拿到窗口多大、把它塞回去」那两行，而在下面这三件：
//!
//! 1. **什么时候不许记** —— 最大化 / 全屏时的尺寸**不是用户选的大小**，是屏幕的大小。
//!    记了它，下次启动会把窗口开成「屏幕那么大、但**不是最大化状态**」：
//!    用户拖一下才发现它其实没最大化，而且那个尺寸已经被写进配置了。
//!    ⚠️ 这条判据要 `is_maximized()` / `is_fullscreen()`，那是 tauri 才有的 ——
//!    所以**判定留在调用处**（`main.rs`），这里只管「存什么、怎么存」。
//! 2. **写盘频率** —— 拖窗时 `Resized` 是**每帧**来的。一秒钟写几十次是没必要的
//!    （见 [`SaveGate`]）。
//! 3. **这份文件坏了怎么办** —— ⚠️★ 与 `config.json` **故意不一样**：
//!    配置坏了要 `exit(1)`（宁可不启动，也不能带着默认配置去连用户的服务器），
//!    而窗口大小坏了**什么也不该发生** —— 读不出来就当没记过，用 `tauri.conf.json`
//!    里那个默认尺寸。为一份「窗口多大」的偏好停掉整个客户端是本末倒置。
//!
//! # 存的是**逻辑像素**，不是物理像素
//!
//! `tauri.conf.json` 里的 `width` / `height` 就是逻辑像素（那才是不随 DPI 变的那一份）。
//! 存物理像素的话，同一台机器接上/拔掉外接屏（缩放比变了）就会得到一个大得离谱
//! 或者小得离谱的窗口 —— 而**两边的数字都对得上**，所以查起来很难看。
//! 转换（`PhysicalSize` ⇄ `LogicalSize`）在调用处用 `scale_factor()` 做。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 落在数据目录下的文件名。
///
/// ⚠️ 与 `config.json` **并列、不是塞进它里面**：这个文件是**界面的状态**，
/// 不是「客户端配置」。混进去的话，「导出配置」这件事会顺手把窗口几何也带走。
pub const WINDOW_FILE: &str = "window.json";

/// 两次写盘之间至少隔多久（毫秒）。
///
/// ⚠️ 拖窗时 `Resized` 每帧都来，一次一秒能来几十上百次。700ms 是「手停下来之前
/// 最多写几次」与「万一被强杀，丢的也只是最后一次微调」之间的折中。
/// ⚠️ 它**不是**一个要精细调的数：真正保证「最后一次被记住」的是**退出时那一写**
/// （`main.rs` 的 `ExitRequested`），这个节流只是别让拖一次写上百遍。
pub const SAVE_INTERVAL_MS: u64 = 700;

/// 窗口大小（**逻辑像素**，见模块文档）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

impl WindowSize {
    #[must_use]
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// 这个尺寸**能不能当一个窗口用**。
    ///
    /// ⚠️★ 只挡 `0`（那不是一个窗口），**不自己定一个最小值**：
    /// 「最小能多小」是 `tauri.conf.json` 里 `minWidth` / `minHeight` 说了算的，
    /// 在这里再写一份就是**第二个定义** —— 而两份一定会漂（漂了之后，用户拖到比
    /// 我们以为的下限还小，那个尺寸会被记下来、下次贴回去又被 tauri 顶回去）。
    /// 所以这里只做「显然不是窗口」这一种过滤，剩下的交给窗口系统。
    #[must_use]
    pub const fn is_usable(self) -> bool {
        self.width > 0 && self.height > 0
    }

    /// 把它收进 `available` 里（两个方向各取小的那个）。
    ///
    /// ⚠️★ 为什么需要它：用户在外接大屏上把窗口拖得很大，然后拔掉屏幕用笔记本 ——
    /// 存下来的尺寸比现在的屏幕还大，贴回去就是一个**伸到屏幕外面**的窗口
    ///（标题栏在屏幕外 = 拖都拖不回来）。这是「记住窗口大小」这类功能最经典的一个坑。
    ///
    /// ⚠️ `available` 给的是**整块屏幕**的尺寸，不是 work area —— Tauri 的 `Monitor`
    /// 只给 `size()` / `scale_factor()` / `position()`，没有「菜单栏和 dock 让出来的
    /// 那部分」。所以贴出来的窗口可能正好顶到屏幕边（差的那几十像素交给窗口系统推）。
    /// ⚠️ 不在这里减一个「菜单栏大概 25px」——那是**编一个数**，而它在别的平台上就是错的。
    #[must_use]
    pub fn fit_within(self, available: WindowSize) -> Self {
        Self {
            width: self.width.min(available.width),
            height: self.height.min(available.height),
        }
    }
}

/// 窗口大小的文件路径（数据目录下那个）。
#[must_use]
pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join(WINDOW_FILE)
}

/// 系统给的**物理**像素 → 要记下来的那一份（**逻辑**像素，见模块文档）。
///
/// ⚠️★ 为什么要有这个函数、而不是在调用处直接除：除缩放比这件事有**两处**都要做
/// （记窗口大小时、以及「贴回去之前先看看屏幕多大」时）。两处各抄一遍 `÷ scale`
/// 就是**第二份定义** —— 而它们一定会漂（一处加了四舍五入、另一处没加），
/// 漂了之后的表现是「同一块屏，算出来的可用区域和记下来的尺寸不是一个口径」。
/// ⚠️ 顺便它把「坏缩放比怎么办」这一条也收到了一处，而那一条**只有这里**能测
///（调用处要 `tauri::WebviewWindow`，那是真窗口，起不来）。
///
/// ⚠️★ 缩放比坏掉时**返回 `None`（= 这一拍不记）**，不是「用 1.0 凑合」：
/// 记一个错的数比不记坏得多 —— 错的那一份会被写进 `window.json`，
/// 而它**下次启动时会被原样贴回来**（用户看到的是一扇尺寸莫名其妙的窗口）。
pub fn from_physical(width: u32, height: u32, scale: f64) -> Option<WindowSize> {
    // ⚠️★ 这个守卫**不是**摆设：`scale = 0.0` 时上面那一除得到 `inf`，
    // 而 `inf as u32` 是**饱和截断**（`u32::MAX`）—— `is_usable()` 拦不住它
    //（`u32::MAX > 0` 为真），于是一个 `4294967295 × 4294967295` 的窗口会被记下来。
    // ⚠️ `is_finite` 顺带把 `NaN` 与 `inf` 一起挡掉（NaN 走 `<= 0.0` 是 false，
    // 只写 `scale <= 0.0` 会漏掉它）。
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let size = WindowSize::new(
        (f64::from(width) / scale).round() as u32,
        (f64::from(height) / scale).round() as u32,
    );
    size.is_usable().then_some(size)
}

/// 读上一次记下来的大小。
///
/// ⚠️★ **任何**毛病都返回 `None`（文件不在 / 不是 JSON / 少了字段 / 是 `0`）——
/// 一个都不往上抛：调用处拿到 `None` 就用默认尺寸，与「第一次运行」完全一样。
/// 见模块文档第 3 条（这里与 `load_config` 的取舍**故意相反**）。
#[must_use]
pub fn load(path: &Path) -> Option<WindowSize> {
    let text = std::fs::read_to_string(path).ok()?;
    let size: WindowSize = serde_json::from_str(&text).ok()?;
    size.is_usable().then_some(size)
}

/// 写下来。
///
/// ⚠️ 与 `config.json` 用**同一套**原子写（临时文件带进程 id + 同目录 `rename`）——
/// 理由与那边一样：`rename` 在同一个文件系统内是原子的，所以不存在「读到半个文件」。
/// ⚠️ 先建父目录（第一次运行时数据目录可能还没有）。
///
/// ⚠️ 返回值是 `std::io::Result` 而不是 `Msg`：这一条**不上屏**。写不进就算了，
/// 调用处只把它打一行日志 —— 为「记不住窗口多大」弹一句界面提示是噪声。
pub fn save(path: &Path, size: WindowSize) -> std::io::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&size)
        .map_err(|reason| std::io::Error::new(std::io::ErrorKind::InvalidData, reason))?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, json.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// 「这一拍要不要真的写盘」—— 拖窗时的节流（见 [`SAVE_INTERVAL_MS`]）。
///
/// ⚠️★ 时间从**外面喂**（毫秒），不在这里读时钟：读了钟就测不了
///（要么睡真时间、要么写一条打不红的假保护）。调用处给 `Instant` 算出来的毫秒数。
#[derive(Debug, Default)]
pub struct SaveGate {
    written: Option<(u64, WindowSize)>,
}

impl SaveGate {
    #[must_use]
    pub const fn new() -> Self {
        Self { written: None }
    }

    /// 记下这一拍，并回答「顺手写一次盘吧？」。
    ///
    /// ⚠️ 两种「不用写」：**尺寸没变**（拖出去又拖回来，最后停在原地）与
    /// **离上次太近**（还在拖）。
    ///
    /// ⚠️★ **这两句谁在前谁在后都对，别以为有个「顺序」。** 2026-09-29 的变异验证
    /// 专门把这两句换了个序 —— 五条用例**一条都没红**。原因是这两条守卫都是
    /// **纯判断**（不碰 `self`）、而且结果同为 `false`，所以四条分支组合的返回值
    /// 一字不差。这里原来写着「第一句必须在前面，否则『尺寸回到上次那个值』会被当成
    /// 一次需要写的变更」——**那句话是错的**（写的时候想漏了「换序之后时间那条会先接住
    /// 它」）。现在这个顺序只是读起来顺：先答「这一拍有没有变更可言」，再看「够不够久」。
    pub fn should_write(&mut self, now_ms: u64, size: WindowSize) -> bool {
        match self.written {
            Some((_, last)) if last == size => false,
            Some((at, _)) if now_ms.saturating_sub(at) < SAVE_INTERVAL_MS => false,
            _ => {
                self.written = Some((now_ms, size));
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("临时目录")
    }

    /// ⚠️★ 「读不出来就当没记过」是**这一份文件与 `config.json` 的差别所在**，
    /// 所以四种坏法各来一条 —— 少测一种，那种坏法就会变成「起不来」。
    #[test]
    fn every_broken_window_file_falls_back_to_no_memory() {
        let dir = round_trip_dir();
        let path = dir.path().join(WINDOW_FILE);

        // ① 文件不在（第一次运行）
        assert_eq!(load(&path), None, "文件不在就是没记过");

        // ② 根本不是 JSON
        std::fs::write(&path, b"not json at all").expect("写");
        assert_eq!(load(&path), None, "不是 JSON 就当没记过");

        // ③ 是 JSON，但少了字段
        std::fs::write(&path, br#"{"width": 800}"#).expect("写");
        assert_eq!(load(&path), None, "缺字段就当没记过");

        // ④ 值不是一个窗口（0）
        std::fs::write(&path, br#"{"width": 0, "height": 500}"#).expect("写");
        assert_eq!(load(&path), None, "0 宽不是一个窗口");

        // ⚠️★ 对照组：**能读出来的**那一种，上面四条才说明是「按内容判」而不是
        // 「`load` 永远返回 None」—— 少了这一条，前四条在 `load` 被改成 `None`
        // 常量时**照样全绿**。
        std::fs::write(&path, br#"{"width": 900, "height": 600}"#).expect("写");
        assert_eq!(load(&path), Some(WindowSize::new(900, 600)));
    }

    #[test]
    fn what_was_saved_is_what_comes_back() {
        let dir = round_trip_dir();
        let path = dir.path().join(WINDOW_FILE);
        save(&path, WindowSize::new(1024, 768)).expect("写");
        assert_eq!(load(&path), Some(WindowSize::new(1024, 768)));
        // ⚠️ 覆盖写也得对（用户第二次换了大小）
        save(&path, WindowSize::new(800, 500)).expect("写");
        assert_eq!(load(&path), Some(WindowSize::new(800, 500)));
    }

    /// ⚠️ 父目录不在时要**自己建**：第一次运行时数据目录可能还没被创建
    ///（`main.rs` 里虽然先建过一次，但 `-data` 指到别处、或者那个目录被用户删掉
    /// 都够让它不在）。不建的话表现是「一直记不住」，而**不报错**。
    #[test]
    fn saving_creates_the_directory() {
        let dir = round_trip_dir();
        let path = dir.path().join("nested").join("deeper").join(WINDOW_FILE);
        save(&path, WindowSize::new(700, 480)).expect("写");
        assert_eq!(load(&path), Some(WindowSize::new(700, 480)));
    }

    /// ⚠️★ 系统给的是**物理**像素，记下来与贴回去的都是**逻辑**像素 —— 这一除
    /// 是「同一台机器接上／拔掉外接屏之后窗口还是原来的大小」唯一的依据。
    /// ⚠️ 这里**每条断言都能被打红**（怎么打见每句后面的括注）—— 不写打不红的。
    #[test]
    fn a_physical_pixel_count_becomes_a_logical_one_and_a_broken_scale_records_nothing() {
        // Retina：物理 1600 → 逻辑 800。（拿掉那个除法 → 这条红）
        assert_eq!(
            from_physical(1600, 1200, 2.0),
            Some(WindowSize::new(800, 600))
        );
        // ⚠️ 对照组：1.0 的屏上**一个字都不许改**。（把除法写成「恒除以 2」→ 这条红）
        assert_eq!(
            from_physical(1600, 1200, 1.0),
            Some(WindowSize::new(1600, 1200))
        );
        // ⚠️★ 缩放比是 0 → 上面那一除得到 `inf`，`inf as u32` 是**饱和截断**（`u32::MAX`），
        // 而 `u32::MAX > 0` 为真 —— `is_usable()` **拦不住**它。所以这条打的正是那个坏值守卫。
        // （拿掉 `!scale.is_finite() || scale <= 0.0` → 这条红，而且红出来的是 4294967295）
        assert_eq!(from_physical(1600, 1200, 0.0), None);
        // 负的 / NaN 同款（NaN 走 `!is_finite`；只写 `scale <= 0.0` 会漏掉它）
        assert_eq!(from_physical(1600, 1200, -2.0), None);
        assert_eq!(from_physical(1600, 1200, f64::NAN), None);
        // 物理尺寸本身就是 0（屏幕/窗口拿不到）→ 不是一个窗口大小
        // （拿掉 `is_usable()` 那半句 → 这条红）
        assert_eq!(from_physical(0, 1200, 2.0), None);
        assert_eq!(from_physical(1600, 0, 2.0), None);
        // ⚠️ 四舍五入而不是截断：3 个物理像素在 2.0 的屏上是 1.5 → 2（`as u32` 会给 1）
        assert_eq!(from_physical(3, 5, 2.0), Some(WindowSize::new(2, 3)));
    }

    /// 拔掉大屏之后贴回来的窗口不许伸到屏幕外面去。
    #[test]
    fn a_too_large_size_shrinks_to_fit_but_a_fitting_one_is_untouched() {
        let screen = WindowSize::new(1440, 900);
        // 太大 → 收进屏幕
        assert_eq!(WindowSize::new(2560, 1400).fit_within(screen), screen);
        // 只超一个方向 → 那个方向收，另一个方向**不动**
        assert_eq!(
            WindowSize::new(1000, 2000).fit_within(screen),
            WindowSize::new(1000, 900)
        );
        // 装得下 → **一个字都不改**（这条是上面两条的对照组：少了它，
        // `fit_within` 被改成「永远返回 available」也照样绿）
        let small = WindowSize::new(800, 520);
        assert_eq!(small.fit_within(screen), small);
    }

    /// 拖窗时的节流：没变不写、太近不写、变了且够久了才写。
    #[test]
    fn the_gate_throttles_a_drag_but_never_loses_the_last_size() {
        let mut gate = SaveGate::new();
        let a = WindowSize::new(800, 520);
        let b = WindowSize::new(820, 540);

        // 第一次总是写（还没记过任何东西）
        assert!(gate.should_write(0, a), "第一次要写");
        // 尺寸一模一样 → 不写
        assert!(!gate.should_write(10_000, a), "尺寸没变就不用写");
        // 变了，但离上次太近 → 不写（这一拍正是在拖）
        assert!(!gate.should_write(300, b), "还在拖，先别写");
        // 变了一点点、也够久了 → 写
        assert!(gate.should_write(SAVE_INTERVAL_MS, b), "停下来就该写");
        // ⚠️ 边界：**正好**差一个节流间隔算「够久」（判的是 `>=`），差一毫秒不算。
        assert!(
            !gate.should_write(SAVE_INTERVAL_MS * 2 - 1, a),
            "还差一毫秒，别写"
        );
        assert!(
            gate.should_write(SAVE_INTERVAL_MS * 2, a),
            "正好够久了，该写"
        );
    }
}
