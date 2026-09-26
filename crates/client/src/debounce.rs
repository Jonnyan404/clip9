//! 去重防抖 —— ⚠️★ **三个哈希，不是一个**。

use std::path::PathBuf;

use crate::classify::classify_text;
use crate::event::{ClipboardContent, ClipboardEvent};

/// 上一次见过的内容指纹（**按类型分开**）。
///
/// ⚠️★ 为什么必须按类型分开（`docs/specs/desktop-client.md` §8 审计清单点名的那条）：
/// 「复制一段文本、再复制一张图」是**两次不同的事件** —— 共用一个哈希的话，
/// 第二次会被判成「重复」而**静默吞掉**。表现是「复制了图，对端没收到」，
/// 而日志里一切正常 —— 这类「配了不生效」正是这个项目最忌讳的。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprints {
    pub text: u64,
    pub image: u64,
    pub files: u64,
}

/// DJB2 —— `clip-sync`（本 crate 的行为基准）用的就是它。
///
/// ⚠️ 它**不是**密码学哈希，也不需要是：这里只判「跟上次是不是同一份内容」，
/// 而且比的是**本进程内存里的上一次**（不落盘、不过网，没有对抗性输入）。
#[must_use]
pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut hash: u64 = 5381;
    for byte in data {
        hash = ((hash << 5).wrapping_add(hash)).wrapping_add(u64::from(*byte));
    }
    hash
}

/// 文件列表的指纹：**先拼起来再哈希**（与 `clip-sync` 一致）。
#[must_use]
pub fn hash_paths(paths: &[PathBuf]) -> u64 {
    let joined: String = paths.iter().map(|p| p.to_string_lossy()).collect();
    hash_bytes(joined.as_bytes())
}

/// 去重状态机。
#[derive(Debug, Default)]
pub struct Debouncer {
    seen: Fingerprints,
}

impl Debouncer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前记着的指纹（诊断 / 测试用）。
    #[must_use]
    pub fn fingerprints(&self) -> Fingerprints {
        self.seen
    }

    /// 这份内容要不要**当成一次新事件**？
    ///
    /// 要 → 记下指纹、返回分类好的 [`ClipboardEvent`]；
    /// 不要（与上一次同一份，或内容为空）→ `None`，调用方直接跳过。
    pub fn accept(&mut self, content: ClipboardContent) -> Option<ClipboardEvent> {
        match content {
            ClipboardContent::Files(paths) => {
                if paths.is_empty() {
                    return None;
                }
                let fingerprint = hash_paths(&paths);
                if fingerprint == self.seen.files {
                    return None;
                }
                self.seen.files = fingerprint;
                Some(ClipboardEvent::Files { paths })
            }
            ClipboardContent::Image(png) => {
                if png.is_empty() {
                    return None;
                }
                let fingerprint = hash_bytes(&png);
                if fingerprint == self.seen.image {
                    return None;
                }
                self.seen.image = fingerprint;
                // ⚠️ 照 `clip-sync` 的行为：**换到图片时把文本指纹清掉**。
                // 否则「复制一张图 → 再复制回同一段文本」会被判成重复而不发。
                self.seen.text = 0;
                Some(ClipboardEvent::Image { png })
            }
            ClipboardContent::Text(text) => {
                if text.is_empty() {
                    return None;
                }
                let fingerprint = hash_bytes(text.as_bytes());
                if fingerprint == self.seen.text {
                    return None;
                }
                self.seen.text = fingerprint;
                let subtype = classify_text(&text);
                Some(ClipboardEvent::Text {
                    content: text,
                    subtype,
                })
            }
        }
    }

    /// 预置指纹 —— 把「我刚写进剪贴板的这份内容」记下来，**不产生事件**。
    ///
    /// # 它唯一的用途是**防回环**
    ///
    /// 下行把收到的内容写进剪贴板时，先调它，下一轮监控读到的就是同一份内容 →
    /// 被判成重复 → 不会又发回服务端。不预置的话：A 写剪贴板 → A 的上行把它发出去 →
    /// B 收到又写自己的剪贴板 → B 的上行发回来 → …… 两个客户端之间**来回弹**。
    ///
    /// ⚠️★ 这也是 `watcher` 与 `receiver` **必须共享同一个 `Debouncer`** 的原因 ——
    /// 各自持有一个的话，各自记得的「上一次」互不相干，预置等于没预置。
    ///
    /// ⚠️ 清的槽照抄行为基准（`clip-sync` 的 `receiver.rs`：写文本时把图片与文件的
    /// 指纹一起清零、写图片时清文本）。别自己发明一套 —— 两边规则不一样会让
    /// 「同一串操作」在两个客户端上表现不同。
    ///
    /// ⚠️ 空内容 = **什么都没写**，所以什么都不动（与 [`Debouncer::accept`] 的口径一致）。
    pub fn prime(&mut self, content: &ClipboardContent) {
        match content {
            ClipboardContent::Text(text) => {
                if text.is_empty() {
                    return;
                }
                self.seen.text = hash_bytes(text.as_bytes());
                self.seen.image = 0;
                self.seen.files = 0;
            }
            ClipboardContent::Image(png) => {
                if png.is_empty() {
                    return;
                }
                self.seen.image = hash_bytes(png);
                self.seen.text = 0;
            }
            ClipboardContent::Files(paths) => {
                if paths.is_empty() {
                    return;
                }
                self.seen.files = hash_paths(paths);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::TextSubtype;

    fn text(s: &str) -> ClipboardContent {
        ClipboardContent::Text(s.to_owned())
    }

    fn files(v: &[&str]) -> ClipboardContent {
        ClipboardContent::Files(v.iter().map(PathBuf::from).collect())
    }

    fn is_text(ev: &ClipboardEvent, expect: &str) -> bool {
        matches!(ev, ClipboardEvent::Text { content, .. } if content == expect)
    }

    #[test]
    fn duplicate_text_is_swallowed() {
        let mut d = Debouncer::new();
        assert!(d.accept(text("hello")).is_some());
        assert!(
            d.accept(text("hello")).is_none(),
            "同一份文本第二次不该再发"
        );
        assert!(d.accept(text("hello!")).is_some(), "换了内容要发");
    }

    /// ⚠️★ **直接钉住「哪个类型写哪个槽」。**
    ///
    /// 为什么需要这么白的断言：光靠「文本之后复制图片也能发」是**测不出来**的 ——
    /// 那条用例里 `files` 槽一直是 0，图片写错槽也照样能过。
    /// （实测过：把图片分支的判重槽从 `image` 改成 `files`，只靠行为用例**全绿**。）
    #[test]
    fn each_type_writes_its_own_slot() {
        let mut d = Debouncer::new();

        d.accept(text("t"));
        assert_eq!(d.fingerprints().text, hash_bytes(b"t"));
        assert_eq!(d.fingerprints().image, 0, "文本不该动图片的槽");
        assert_eq!(d.fingerprints().files, 0, "文本不该动文件的槽");

        d.accept(ClipboardContent::Image(vec![1, 2, 3]));
        assert_eq!(d.fingerprints().image, hash_bytes(&[1, 2, 3]));
        assert_eq!(d.fingerprints().files, 0, "图片不该动文件的槽");

        d.accept(files(&["/x"]));
        assert_eq!(d.fingerprints().files, hash_paths(&[PathBuf::from("/x")]));
    }

    /// 三种内容**交替**出现时，每一样都还能被正确判重。
    ///
    /// ⚠️ 这条的价值在于「三个槽必须各自记账」—— 只让一种内容参与的话，
    /// 共享一个槽也能蒙混过去（见上一条的注释）。
    ///
    /// ⚠️★ 这条**改过两次**，两次都白写了，记下来免得下次再踩：
    ///
    /// 1. **别把图片夹在「两次相同文本」中间** —— 图片分支会按行为基准
    ///    **清掉文本指纹**（见 `image_resets_the_text_fingerprint`），
    ///    所以「文本 → 图片 → 文本」里最后那次**本来就该发**。写成「都该被吞」
    ///    会让它**恒红**，反而掩盖了它本该抓的东西。
    /// 2. **图片也不能只在末尾单独跑一遍** —— 那样它自己连着用两次自己的槽，
    ///    写错槽也照样能吞，等于没测（实测过：变异成 `files` 槽，这条**仍然全绿**）。
    ///
    /// 真正的判据是：**让图片夹在两次相同的文件中间** —— 图片要是写了文件的槽，
    /// 后面那次「同一批文件」就会被误判成新内容而重发。
    #[test]
    fn types_do_not_share_a_slot() {
        let mut d = Debouncer::new();

        // 文本与文件交替（不夹图片）—— 各自记账。
        assert!(d.accept(text("same")).is_some());
        assert!(d.accept(files(&["/a"])).is_some());
        assert!(
            d.accept(text("same")).is_none(),
            "文本没被去重（中间只夹了文件 —— 它写的是别的槽）"
        );
        assert!(d.accept(files(&["/a"])).is_none(), "文件没被去重");

        // ⚠️★ 关键一步：图片夹在「两次同一批文件」中间。
        assert!(d.accept(ClipboardContent::Image(vec![1])).is_some());
        assert!(
            d.accept(files(&["/a"])).is_none(),
            "图片动了文件的槽 —— 同一批文件被当成新内容重发了"
        );
        // 图片自己也要能记住。
        assert!(
            d.accept(ClipboardContent::Image(vec![1])).is_none(),
            "图片没被去重（很可能它写的是别的槽）"
        );
    }

    /// ⚠️★ **这条钉住「三个哈希，不是一个」** —— 那是最容易写错、又最难发现的一处
    /// （写错的表现是「复制了图，对端没收到」，而日志里一切正常）。
    #[test]
    fn text_then_image_both_go_through() {
        let mut d = Debouncer::new();
        assert!(d.accept(text("hi")).is_some());

        let png = vec![1u8, 2, 3, 4];
        assert!(
            d.accept(ClipboardContent::Image(png.clone())).is_some(),
            "文本之后复制图片，必须当成新事件（共用一个哈希就会在这里被吞掉）"
        );
        // 同一张图再来一次 —— 这次才该被吞。
        assert!(d.accept(ClipboardContent::Image(png)).is_none());
    }

    /// 反过来也要成立。
    #[test]
    fn image_then_text_both_go_through() {
        let mut d = Debouncer::new();
        assert!(d.accept(ClipboardContent::Image(vec![9, 9, 9])).is_some());
        assert!(
            d.accept(text("note")).is_some(),
            "图片之后复制文本，必须当成新事件"
        );
    }

    /// ⚠️ 这一条钉的是**照抄行为基准**、不是「逻辑上必须如此」：
    /// `clip-sync` 换到图片时会把文本指纹清零，于是
    /// 「复制文本 A → 复制图 → 再复制文本 A」里**最后那次会发**。
    /// 改成别的行为就得同步改 `clip-sync`，别忘了。
    #[test]
    fn image_resets_the_text_fingerprint() {
        let mut d = Debouncer::new();
        assert!(d.accept(text("A")).is_some());
        assert!(d.accept(ClipboardContent::Image(vec![7])).is_some());
        assert!(
            d.accept(text("A")).is_some(),
            "换到图片之后文本指纹被清零 —— 同一段文本应当再发一次（clip-sync 的行为）"
        );
    }

    #[test]
    fn files_dedup_by_the_whole_list() {
        let mut d = Debouncer::new();
        assert!(d.accept(files(&["/a", "/b"])).is_some());
        assert!(
            d.accept(files(&["/a", "/b"])).is_none(),
            "同一批文件不该重复发"
        );
        assert!(d.accept(files(&["/a"])).is_some(), "文件列表变了要发");
    }

    /// 空内容**永远**不是事件，而且**不该动指纹** ——
    /// 否则「复制空 → 复制正常内容」会被上一次的空骗过一次。
    #[test]
    fn empty_content_is_never_an_event() {
        let mut d = Debouncer::new();
        assert!(d.accept(text("")).is_none());
        assert!(d.accept(files(&[])).is_none());
        assert!(d.accept(ClipboardContent::Image(Vec::new())).is_none());
        assert_eq!(
            d.fingerprints(),
            Fingerprints::default(),
            "空内容不该改动指纹"
        );
    }

    #[test]
    fn text_carries_its_subtype() {
        let mut d = Debouncer::new();
        let ev = d.accept(text("https://example.com")).expect("第一次要发");
        assert_eq!(
            ev,
            ClipboardEvent::Text {
                content: "https://example.com".to_owned(),
                subtype: Some(TextSubtype::Url)
            }
        );
    }

    /// 端到端串一遍：分类器与去重器是**接在一起**的（`accept` 内部会调分类）。
    #[test]
    fn accept_runs_the_classifier() {
        let mut d = Debouncer::new();
        let ev = d.accept(text("someone@example.com")).expect("要发");
        assert!(matches!(
            ev,
            ClipboardEvent::Text {
                subtype: Some(TextSubtype::Email),
                ..
            }
        ));
        let mut d = Debouncer::new();
        let ev = d.accept(text("普通一句话")).expect("要发");
        assert!(matches!(ev, ClipboardEvent::Text { subtype: None, .. }));
    }

    #[test]
    fn hash_is_stable_djb2() {
        // 与 `clip-sync` 的 DJB2 逐位一致（这是**能对得上的**那一半；
        // 具体的数值不重要，稳定才重要）。
        assert_eq!(hash_bytes(b""), 5381);
        assert_eq!(hash_bytes(b"a"), hash_bytes(b"a"));
        assert_ne!(hash_bytes(b"a"), hash_bytes(b"b"));
        let _ = is_text;
    }

    /// ⚠️★ **这条钉住防回环**（`prime` 存在的全部理由）。
    ///
    /// 下行把收到的文本写进剪贴板时会先 `prime` —— 于是监控线程下一轮读到同一份内容
    /// 时，`accept` 必须**吞掉它**。吞不掉的话，两个客户端之间会来回弹。
    #[test]
    fn priming_makes_the_next_read_look_like_a_duplicate() {
        let mut d = Debouncer::new();
        d.prime(&text("远端发来的"));

        assert!(
            d.accept(text("远端发来的")).is_none(),
            "刚写进剪贴板的文本又被当成新内容了 —— 防回环失效"
        );
        // 但用户**真的**复制了别的东西，还是照发。
        assert!(d.accept(text("用户复制的")).is_some());
    }

    /// 文件那一侧同样要成立（下载落盘之后写剪贴板走的就是它）。
    #[test]
    fn priming_files_also_breaks_the_loop() {
        let mut d = Debouncer::new();
        d.prime(&files(&["/dl/a.txt"]));
        assert!(
            d.accept(files(&["/dl/a.txt"])).is_none(),
            "刚落盘并写进剪贴板的文件不该再发回去"
        );
        assert!(d.accept(files(&["/dl/b.txt"])).is_some());
    }

    /// ⚠️ 清槽的规则照抄行为基准：写文本时把图片与文件指纹一起清零。
    #[test]
    fn priming_follows_the_baseline_slot_rules() {
        let mut d = Debouncer::new();
        // 先让三个槽都有值。
        d.accept(text("t"));
        d.accept(ClipboardContent::Image(vec![1]));
        d.accept(files(&["/a"]));

        // 写一段新文本 —— 图片与文件的指纹要一起清零。
        d.prime(&text("新的"));
        assert_eq!(d.fingerprints().text, hash_bytes("新的".as_bytes()));
        assert_eq!(d.fingerprints().image, 0, "写文本要把图片槽清零");
        assert_eq!(d.fingerprints().files, 0, "写文本要把文件槽清零");

        // 写图片同理（清文本）。
        d.accept(text("t2"));
        d.prime(&ClipboardContent::Image(vec![9]));
        assert_eq!(d.fingerprints().image, hash_bytes(&[9]));
        assert_eq!(d.fingerprints().text, 0, "写图片要把文本槽清零");
    }

    /// 空内容 = 什么都没写，所以**不该动指纹** ——
    /// 否则一次「写空」会把上一次的指纹擦掉，让同一份内容被重发一遍。
    #[test]
    fn priming_empty_content_changes_nothing() {
        let mut d = Debouncer::new();
        d.accept(text("keep"));
        let before = d.fingerprints();

        d.prime(&text(""));
        d.prime(&ClipboardContent::Image(Vec::new()));
        d.prime(&files(&[]));
        assert_eq!(d.fingerprints(), before, "空内容不该动指纹");
        assert!(d.accept(text("keep")).is_none(), "原来的判重也该还在");
    }
}
