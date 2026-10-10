//! `doc` —— 文档（Word / PowerPoint / Excel / OpenDocument / RTF / EPUB / PDF / CSV）→ Markdown。
//!
//! # ⚠️ 它**不是**一个动作，别把它塞进 `registry`
//!
//! `registry` 那张表的 `id` / `key` 是**冻结的跨端契约**：由
//! `cases/actions/registry.json` 钉住，`tests/contract_cases.rs` 双向比对
//! （少一个红、多一个也红）。而 `cases/README.md` 说得很清楚：那份 fixture 是
//! **本仓库自己的冻结基准**，改它就是一次**契约变更**（要走那三条流程），
//! 不是「顺手加一条」的事。所以这边**不能**顺手加一个 `doc.toMarkdown` 进去：
//! 那条路只有两种走法，两种都不能走 ——
//!
//! - 加进 `registry` 而不动 fixture：`i18n_keys_match_the_baseline_exactly` 立刻报「这边多了这些 key」；
//! - 加进 `registry` 并手改 fixture：那是**契约变更**，得先回答「这是不是线上形状」，
//!   而这里显然不是 —— 加一个动作会让已有的动作选择器多出一项。
//!
//! 还有一条更硬的理由：**形状对不上**。注册表那条链的接口是 `&str → &str`
//! （`registry::run(id, input: &str, …)`），而文档转换的输入是**字节** ——
//! 硬塞进去只能走 base64 中转，那既多一层编解码，又让「这条链只处理文本」这个前提失效。
//!
//! 所以它**平级于 `offset`**：一个 `pub` 的纯函数模块，由调用方（服务端的转换端点、
//! 将来的 WASM 绑定）直接调。要让它进自动化界面的动作选择器，得先给 `cases/actions/`
//! 补一批文档转换的用例（那是一次契约变更），那是另一件事。
//!
//! # 仍然是「一份实现、编译两次」的那一份
//!
//! ⚠️ 这个模块**必须保持纯函数、无 IO**（同 `lib.rs` 抬头那条）：
//!
//! - 只用 [`anydoc::to_markdown_bytes`]，**绝不用** [`anydoc::to_markdown`]（那个按路径读盘）。
//! - 因此原生（服务端）与 `wasm32-unknown-unknown`（浏览器）能编同一份代码 ——
//!   将来前端直接本地转换，不必把文件传上服务端。anydoc 上游本身就有 wasm 绑定
//!   （`@firecrawl/anydoc-wasm`），这条不是设想。
//!
//! # 为什么**不做** OCR
//!
//! anydoc 对纯文字 PDF 是本地解析，但**扫描件 / 纯图片页**会回
//! [`anydoc::ConvertError::NeedsOcr`]。上游给的路子是把那些页送去 Firecrawl 的托管 OCR ——
//! **这条路 clip9 不走**：这是个自托管、离线优先的东西（`ARCHITECTURE.md` 的定位），
//! 把用户的文档发去第三方换取一次转换，与「数据握在自己手里」直接冲突。
//! 所以这里把 `NeedsOcr` 转成一句**说清楚原因**的报错，而不是静默返回一个缺页的结果。
//!
//! ⚠️ 这条与 `error.rs` 抬头那条「不要给失败配兜底」是同一件事的两个面：
//! 一份缺了扫描页的 Markdown **看起来是成功的**，而它悄悄丢掉了用户以为在里面的内容。

use anydoc::{ConvertError, Format};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::error::ActionError;

/// 一次转换的完整结果。
///
/// ⚠️ 为什么不只回一个 `String`：`anydoc` 转 Markdown 时会**把内嵌图片整段丢掉**
/// （`document_to_markdown` 对 `Inline::Image` 什么都不输出 —— 实测过，
/// 连 `![alt]` 都没有）。而图片的**字节**在文档模型里是**有的**
/// （`Document::assets`，上游注释原话是 "Bytes are always retained"）。
/// 所以要多走一次 `to_document` 把它们捞出来，否则用户拖一份带图的产品文档进来，
/// 只会得到一张没有图的树，**而且不知道少了什么**。
#[derive(Debug)]
pub struct Converted {
    /// 正文的 Markdown（与 [`to_markdown`] 的返回值逐字节相同）。
    pub markdown: String,
    /// 文档里的图片。
    ///
    /// ⚠️★ **`None` 不是「没有图」，是「这个格式读不出来」** ——
    /// `to_document` 对 **PDF 不支持**（PDF 直接出 Markdown，没有文档模型形态）。
    /// 把 `None` 当 0 显示，等于对一份满是插图的 PDF 说「这份文档没有图片」，
    /// 那是**编造事实**。调用方必须把两者分开说。
    pub images: Option<ImageSet>,
}

/// 文档里的图片集合。
#[derive(Debug)]
pub struct ImageSet {
    /// **找到的**图片总数。可能大于 `items.len()`（见 `truncated`）。
    pub total: usize,
    /// 真的取出来的那些（按文档顺序）。
    pub items: Vec<ImageAsset>,
    /// 因为超出 [`MAX_IMAGE_TOTAL`] 而没取全。
    pub truncated: bool,
}

/// 一张取出来的图片。
#[derive(Debug)]
pub struct ImageAsset {
    /// MIME，例如 `image/png`。
    pub media_type: String,
    /// 图片原始字节的 **base64**（不带 `data:` 前缀 —— 前缀由调用方拼，
    /// 因为「怎么用」是调用方的事，这里只管把字节安全地放进 JSON）。
    pub data_base64: String,
    /// 原始字节数（给界面显示用，免得前端再解一遍 base64 才知道多大）。
    pub bytes: usize,
}

/// 一次转换最多带走多少图片字节。
///
/// ⚠️ 这个数管的是**响应体大小**，不是内存：base64 会把体积撑大约 4/3，
/// 所以 8 MiB 的原图 ≈ 11 MB 的 JSON。再大就不该塞进一个 HTTP 响应里了 ——
/// 那会让「拖一份带 50 张照片的文档」变成一次超时，而用户只看到「导入失败」。
///
/// ⚠️ 超了**不是静默截断**：`ImageSet::truncated` 会如实报出来，
/// 界面据此说「这份文档有 N 张图，画布上只放了前 M 张」。
pub const MAX_IMAGE_TOTAL: usize = 8 * 1024 * 1024;

/// 认得的文档扩展名（小写，不带点）。
///
/// 给界面用两处：`<input accept>` 的取值、以及「这个文件能不能转」的提示。
/// ⚠️ 它**不是**判定依据 —— 真正的判定是 [`to_markdown`] 内部的内容嗅探 + 扩展名兜底
/// （见那里的注释）。这里只是让界面在**还没读到字节时**能给个像样的提示。
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "doc", "docx", "docm", "odt", "pdf", "pptx", "pptm", "ppsx", "ppsm", "ppt", "pps", "pot",
    "rtf", "epub", "xlsx", "xlsm", "xlsb", "xls", "ods", "odp", "csv",
];

/// 这份文件名看起来像不像能转的文档（只看扩展名，不读字节）。
///
/// ⚠️ 判「不像」不等于判「转不了」：CSV 之外还有认不出扩展名、但内容能被嗅探出来的情况
/// （比如用户把 `.docx` 改名成 `.bin`）。所以界面拿到 `false` 时的文案该是
/// 「可能转不了」，不是「这个文件不行」。
#[must_use]
pub fn looks_like_document(filename: &str) -> bool {
    extension_of(filename).is_some_and(|ext| Format::from_extension(ext).is_some())
}

/// 文档字节 → Markdown（**不要图片**的那条简路）。
///
/// 等价于 `convert(bytes, filename)?.markdown`，但**不会**为了图片多解析一遍
/// （见 [`convert`] 的性能说明）。只想要正文时用它。
///
/// # Errors
///
/// 同 [`convert`]。
pub fn to_markdown(bytes: &[u8], filename: Option<&str>) -> Result<String, ActionError> {
    if bytes.is_empty() {
        return Err(invalid("文件是空的，没有内容可转"));
    }
    let format = detect(bytes, filename);
    let markdown = anydoc::to_markdown_bytes(bytes, format).map_err(explain)?;
    reject_empty(&markdown)?;
    Ok(markdown)
}

/// 文档字节 → Markdown **+ 内嵌图片**。
///
/// # ⚠️ 代价：要解析**两遍**
///
/// `to_markdown_bytes` 内部本来就是 `document_to_markdown(to_document(bytes)?)`，
/// 而 `document_to_markdown` **不是公开 API** —— 拿不到「既给我 Markdown、
/// 又给我文档模型」的调用方式。所以这里只能解析两次。
///
/// 为什么仍然值得：`anydoc` 自己的基准是中位 **4.4 ms**，翻倍也就是 9 ms；
/// 而**图片静默消失**是用户看不出来的那类损失。真的遇到大文档再说 ——
/// 那时该做的是给上游提一个「一次解析、两样都要」的 API，而不是在这儿
/// 手搓一个 Markdown 渲染器（那是第二个实现，必然漂）。
///
/// ⚠️ PDF 那条路**只解析一遍**：`to_document` 对它恒回 `Unsupported`，
/// 所以图片集合是 `None`（读不出来），而不是 `Some(空)`（没有图）。
///
/// # Errors
///
/// 认不出格式、文档加密、结构损坏、超出安全上限、以及**扫描件需要 OCR**
/// 都会回 [`ActionError::InvalidInput`]（文案是给人看的中文，与 `error.rs` 的约定一致）。
/// ⚠️ **空的转换结果也算失败**：那是「看着成功、其实什么都没拿到」。
pub fn convert(bytes: &[u8], filename: Option<&str>) -> Result<Converted, ActionError> {
    if bytes.is_empty() {
        return Err(invalid("文件是空的，没有内容可转"));
    }

    let format = detect(bytes, filename);
    let markdown = anydoc::to_markdown_bytes(bytes, format).map_err(explain)?;
    reject_empty(&markdown)?;

    Ok(Converted {
        markdown,
        images: extract_images(bytes, format),
    })
}

/// 把文档里的图片捞出来（base64）。
///
/// ⚠️ 读不出文档模型时回 **`None`**，不回 `Some(空)`：见 [`Converted::images`] 的注释。
/// ⚠️ 这里**吞掉** `to_document` 的错误是有意的：能走到这一步说明
/// `to_markdown_bytes` 刚刚成功过，而它内部走的是**同一个** `to_document` ——
/// 再失败一次只可能是 PDF（`Unsupported`）。把它的错误往上抛，会把
/// 「图片读不出来」升级成「整份文档转不了」，那是**倒退**。
fn extract_images(bytes: &[u8], format: Option<Format>) -> Option<ImageSet> {
    let document = anydoc::to_document(bytes, format).ok()?;

    let images: Vec<&anydoc::model::Asset> = document
        .assets
        .iter()
        .filter(|asset| asset.media_type.starts_with("image/"))
        .collect();

    let (items, truncated) = cap_images(&images, MAX_IMAGE_TOTAL);
    Some(ImageSet {
        total: images.len(),
        items,
        truncated,
    })
}

/// 按预算把图片转成 base64，装不下就停。
///
/// ⚠️★ **一旦有一张装不下就停下**，不再试后面那些更小的 ——
/// 顺序即文档顺序，跳过一张去装下一张会让「前 M 张」这句话变成谎话，
/// 而界面上正是这么说的。宁可少带几张，也不要给一句对不上的数。
///
/// ⚠️ 单独抽出来是为了**可测**：给一段真的 8 MiB 图片造用例太慢，
/// 而这段「什么时候停」的逻辑恰恰是最容易写错的地方（差一、越界、算了不收）。
fn cap_images(assets: &[&anydoc::model::Asset], budget: usize) -> (Vec<ImageAsset>, bool) {
    let mut items = Vec::new();
    let mut left = budget;
    for asset in assets {
        if asset.bytes.len() > left {
            return (items, true);
        }
        left -= asset.bytes.len();
        items.push(ImageAsset {
            media_type: asset.media_type.clone(),
            data_base64: BASE64.encode(&asset.bytes),
            bytes: asset.bytes.len(),
        });
    }
    (items, false)
}

/// 格式判定：**内容优先、扩展名兜底**（与上游 `anydoc::to_markdown` 同一条规矩）。
///
/// 理由：扩展名是**用户可改的**、内容不是 —— 一份 `.txt` 里装着 docx，
/// 按内容转是对的；反过来按扩展名硬套只会得到「malformed」这种看不懂的报错。
/// ⚠️ CSV 没有签名，所以它**必须**有名字才认得出来。
fn detect(bytes: &[u8], filename: Option<&str>) -> Option<Format> {
    Format::from_bytes(bytes).or_else(|| {
        filename
            .and_then(extension_of)
            .and_then(Format::from_extension)
    })
}

/// ⚠️ 空结果**不能**当成功：一份只有图片的 docx、或一个空表格，转出来就是空串。
/// 把它当成功会让调用方铺出一张空白白板，而用户以为「转好了」。
/// 这与 `format.rs` 的 `reject_noop` 同源 —— 静默的「成功」比明确的失败糟得多。
fn reject_empty(markdown: &str) -> Result<(), ActionError> {
    if markdown.trim().is_empty() {
        return Err(invalid(
            "没能从这份文档里提取出正文（可能是纯图片或空文档）",
        ));
    }
    Ok(())
}

/// 取小写扩展名（不带点）。没有扩展名、或扩展名不是合法 UTF-8 时回 `None`。
fn extension_of(filename: &str) -> Option<&str> {
    let (_, ext) = filename.rsplit_once('.')?;
    // ⚠️ 排除两种不是扩展名的东西：`archive.tar.` 里的空串、以及 `.gitignore`
    // 那种「点开头、整串就是文件名」的情况（`rsplit_once` 会把 `.gitignore` 拆成
    // `""` + `gitignore`，于是它会被当成一个 `gitignore` 类型的文件）。
    if ext.is_empty() || filename.len() == ext.len() + 1 {
        return None;
    }
    Some(ext)
}

/// 把上游的 [`ConvertError`] 翻成**给人看的中文**。
///
/// ⚠️ 上面每一条都**显式列出来**，不留「`_ => 转换失败`」这种一网打尽的兜底 ——
/// 那会让上游新增的错误类型悄悄落进一句什么都没说的文案里。但 `ConvertError` 标了
/// `#[non_exhaustive]`，编译器**强制**要求一个通配分支，所以最后那条把**没见过的
/// `code()`** 原样带出来（而不是吞掉）：真看到它就知道该回来补一条了。
fn explain(error: ConvertError) -> ActionError {
    match error {
        ConvertError::NeedsOcr { pages, page_count } => invalid(format!(
            "这份 PDF 有 {} 页是扫描件或纯图片（共 {page_count} 页），需要 OCR 才能读。\
             clip9 不自带 OCR —— 那要把文档发去第三方服务，与自托管的定位冲突。",
            pages.len()
        )),
        ConvertError::Encrypted => invalid("文档有密码保护，请先解密再转换"),
        ConvertError::Unsupported(what) => invalid(format!("认不出这份文件的格式：{what}")),
        ConvertError::Malformed { part, detail } => match part {
            Some(part) => invalid(format!("文档结构损坏（{part}）：{detail}")),
            None => invalid(format!("文档结构损坏：{detail}")),
        },
        ConvertError::ResourceLimit { limit, detail } => {
            invalid(format!("文档超出了安全上限（{limit}）：{detail}"))
        }
        ConvertError::MissingPart { part } => invalid(format!(
            "文档缺少必需的部分（{part}），可能没有传完或被截断了"
        )),
        // ⚠️ 走到这儿说明**上游在读我们自己已经读进来的字节时出了 IO 错** ——
        // 这是不该发生的事（我们不做任何读盘），所以它是内部错误而不是「用户输入不合法」。
        // 分开报，免得排查的人去翻用户传了什么。
        ConvertError::Io(error) => {
            ActionError::InvalidInput(format!("转换文档时出错（内部错误，不该发生）：{error}"))
        }
        // 见抬头：上游新增的变体落到这里，把它的 code 带出来。
        other => invalid(format!("转换文档失败（{}）：{other}", other.code())),
    }
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ 用例**只用 CSV 和「现造的 docx」**，仓库里**没有二进制 fixture**：
    // CSV 就是逗号分隔的纯文本；docx 由 `chinese_docx()` 在测试里当场拼出来
    // （见那个函数的注释）。往仓库里塞一个真的 `.docx` / `.pdf` 是另一件事 ——
    // 它没法 review、看不出里面写了什么，而且「docx 转得对不对」本来就是
    // anydoc 自己的测试范围，不是这边的。
    //
    // 于是这里守的是**管线**：格式判定、错误翻译、空结果拦截，
    // 外加**中文（CJK）这一条**（`chinese_headings_survive_and_become_markdown_headings`）。
    // 最后那条不是多余的：这个项目的主要用户写中文，而「换一个 anydoc 版本之后
    // 中文变乱码」是**不会报错**的那类回归。

    #[test]
    fn csv_converts_to_a_markdown_table() {
        let csv = b"name,qty\napple,3\npear,5\n";
        let out = to_markdown(csv, Some("fruit.csv")).expect("CSV 应当能转");
        assert!(out.contains("apple"), "结果里应当有数据：{out}");
        assert!(out.contains('|'), "CSV 应当转成表格：{out}");
    }

    /// ⚠️★ 中文（CJK）必须能转 —— **包括标题层级**。
    ///
    /// 为什么这条值得单独一个用例：`anydoc` 是第三方依赖，它升级之后中文变乱码
    /// **不会报任何错** —— 只是用户拿到的 Markdown 里全是问号或者方框。
    /// 而「中文文档」恰恰是这个项目最常见的输入。
    ///
    /// 标题层级也一起钉住，因为它直接决定白板铺出来的形状：
    /// `Heading1/2/3` → `#`/`##`/`###` → `markdown-plan.ts` 的树深度。
    /// 这条断了，白板会从「树」退化成「一长条卡片」，而界面上看不出是 bug。
    #[test]
    fn chinese_headings_survive_and_become_markdown_headings() {
        let out = to_markdown(&chinese_docx(), Some("需求.docx")).expect("中文 docx 应当能转");

        // 正文一个字都不能丢（也不许变成乱码）。
        for expected in [
            "产品需求文档",
            "这是一份中文需求文档，用来验证标题层级能不能被识别。",
            "背景",
            "用户反馈白板功能缺失，需要补齐。",
            "验收标准",
            "标题要变成树形节点，正文要成为卡片。",
        ] {
            assert!(
                out.contains(expected),
                "转出来的 Markdown 里没有「{expected}」：\n{out}"
            );
        }

        // 中文标点与全角符号也要原样（它们是**字符**，不是转义序列）。
        assert!(
            out.contains('：') || out.contains('，'),
            "中文标点没保留：\n{out}"
        );

        // 标题层级：`Heading1` → `#`，`Heading2` → `##`，`Heading3` → `###`。
        let lines: Vec<&str> = out.lines().collect();
        let has = |prefix: &str, text: &str| {
            lines.iter().any(|l| {
                let l = l.trim_start();
                l.starts_with(prefix) && l.trim_start_matches('#').trim() == text
            })
        };
        assert!(has("#", "产品需求文档"), "一级标题没出来：\n{out}");
        assert!(has("##", "背景"), "二级标题没出来：\n{out}");
        assert!(has("##", "目标"), "二级标题没出来：\n{out}");
        assert!(has("###", "验收标准"), "三级标题没出来：\n{out}");

        // ⚠️ 反过来也要钉：**正文不许被当成标题**。
        // 少了这条，一个「把所有段落都加 `#`」的回归会悄悄通过上面四条。
        assert!(
            !lines
                .iter()
                .any(|l| l.trim_start().starts_with('#') && l.contains("用户反馈白板功能缺失")),
            "正文被误判成标题了：\n{out}"
        );
    }

    /// 现造一份**中文 docx** —— docx 就是一个装着 XML 的 zip。
    ///
    /// ⚠️ 为什么不往仓库里放一个真的 `.docx`：二进制 fixture 没法 review
    /// （看不出里面写了什么、改了也不知道），而这里要的只是「一段中文 + 三层标题」，
    /// 几行 XML 就够，还能**一眼看清**测的是什么。
    ///
    /// ⚠️ `styles.xml` 必须带上：`w:pStyle` 引用的样式**得在 styles.xml 里声明**，
    /// 否则 Word / 解析器会当成一个不存在的样式 —— 而 `anydoc` 正是靠它判标题层级的
    /// （`Heading1` → `#`）。少了它，标题会全部退化成正文，而**用例会红**（这正是我们要的）。
    fn chinese_docx() -> Vec<u8> {
        use std::io::{Cursor, Write};

        use zip::write::SimpleFileOptions;

        const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;

        const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

        const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;

        const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
</w:styles>"#;

        fn para(text: &str, style: Option<&str>) -> String {
            let ppr = match style {
                Some(s) => format!(r#"<w:pPr><w:pStyle w:val="{s}"/></w:pPr>"#),
                None => String::new(),
            };
            format!(r#"<w:p>{ppr}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#)
        }

        let document = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
{}{}{}{}{}{}{}{}
</w:body></w:document>"#,
            para("产品需求文档", Some("Heading1")),
            para("这是一份中文需求文档，用来验证标题层级能不能被识别。", None),
            para("背景", Some("Heading2")),
            para("用户反馈白板功能缺失，需要补齐。", None),
            para("目标", Some("Heading2")),
            para("支持中文文档导入，且保留结构。", None),
            para("验收标准", Some("Heading3")),
            para("标题要变成树形节点，正文要成为卡片。", None),
        );

        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES),
            ("_rels/.rels", RELS),
            ("word/_rels/document.xml.rels", DOC_RELS),
            ("word/styles.xml", STYLES),
            ("word/document.xml", &document),
        ] {
            zip.start_file(name, options).expect("写 zip 条目");
            zip.write_all(body.as_bytes()).expect("写 zip 内容");
        }
        zip.finish().expect("收尾 zip").into_inner()
    }

    /// CSV 没有签名 —— 不给出名字就认不出来。这条差异要**可见**，不能靠猜。
    #[test]
    fn csv_without_a_filename_is_unsupported() {
        let csv = b"name,qty\napple,3\n";
        let error = to_markdown(csv, None).expect_err("无名 CSV 应当认不出来");
        assert!(
            matches!(error, ActionError::InvalidInput(ref message) if message.contains("格式")),
            "{error}"
        );
    }

    /// 扩展名只是**兜底**：内容认得出时按内容走。
    /// 这里用一个装成 CSV 的二进制头（`%PDF-`），它会被内容嗅探成 PDF，
    /// 于是报的是「PDF 结构损坏」而不是「CSV 转不出东西」—— 正是「内容优先」的样子。
    #[test]
    fn content_wins_over_the_extension() {
        let fake = b"%PDF-1.7\nthis is not really a pdf";
        let error = to_markdown(fake, Some("lies.csv")).expect_err("假 PDF 应当报错");
        assert!(
            matches!(error, ActionError::InvalidInput(ref message) if message.contains("PDF") || message.contains("损坏")),
            "应当按内容当成 PDF 处理：{error}"
        );
    }

    #[test]
    fn empty_input_is_rejected_before_parsing() {
        let error = to_markdown(b"", Some("empty.docx")).expect_err("空文件应当报错");
        assert!(
            matches!(error, ActionError::InvalidInput(ref message) if message.contains("空的")),
            "{error}"
        );
    }

    #[test]
    fn recognized_extensions_are_listed_and_detected() {
        for name in ["a.docx", "报告.PDF", "deck.pptx", "sheet.xlsx", "notes.md"] {
            let expected = !name.ends_with(".md");
            assert_eq!(looks_like_document(name), expected, "{name}");
        }
        // ⚠️ 这两个是 `extension_of` 的边界：点开头（整串就是文件名）与结尾的点。
        assert!(!looks_like_document(".docx"));
        assert!(!looks_like_document("archive."));
        assert!(!looks_like_document("no-extension"));
    }

    /// 列表里每个扩展名都要真的能被 `anydoc` 认出来 —— 否则界面会提示一个
    /// 点进去必然失败的格式（`accept=` 里列了它、转换时却报「认不出」）。
    #[test]
    fn every_listed_extension_is_known_upstream() {
        for ext in SUPPORTED_EXTENSIONS {
            assert!(
                Format::from_extension(ext).is_some(),
                "{ext} 列在 SUPPORTED_EXTENSIONS 里，但 anydoc 不认识它"
            );
        }
    }

    // ── 内嵌图片 ─────────────────────────────────────────────────────────

    /// ⚠️★ 内嵌图片**必须**被捞出来，因为 Markdown 那条路会把它整个丢掉。
    ///
    /// 这条用例同时钉住两件事，而且第二件是**故意**让它红的：
    ///
    /// 1. `convert()` 的 `images` 里有那张图（字节、MIME、base64 都对）；
    /// 2. **Markdown 里没有它** —— 这是上游 `document_to_markdown` 的行为
    ///    （对 `Inline::Image` 什么都不输出，实测连 `![alt]` 都没有）。
    ///    哪天上游修好了、开始输出 `![alt]`，这条会红，提醒我们
    ///    「`extract_images` 这趟多余的解析可以撤了」。
    ///
    /// 少了这条用例，症状是**用户拖一份带图的产品文档进来、得到一张没有图的树、
    /// 而且不知道少了什么** —— 全程没有任何报错。
    #[test]
    fn embedded_images_are_extracted_even_though_markdown_drops_them() {
        let converted = convert(&docx_with_image(), Some("带图.docx")).expect("带图 docx 应当能转");

        assert!(
            !converted.markdown.contains("!["),
            "上游开始输出 Markdown 图片了？那 `extract_images` 这趟解析可以撤掉：\n{}",
            converted.markdown
        );
        assert!(
            converted.markdown.contains("图之后还有一段文字"),
            "正文不能少"
        );

        let images = converted
            .images
            .expect("docx 应当读得出文档模型（PDF 才是 None）");
        assert_eq!(images.total, 1, "应当找到 1 张图");
        assert_eq!(images.items.len(), 1, "预算足够，不该截断");
        assert!(!images.truncated);

        let image = &images.items[0];
        assert_eq!(image.media_type, "image/png");
        assert_eq!(image.bytes, TINY_PNG.len());
        // ⚠️ base64 要能原样解回那串字节 —— 这是「图片真的能画出来」的前提。
        let decoded = BASE64
            .decode(&image.data_base64)
            .expect("base64 应当能解开");
        assert_eq!(decoded, TINY_PNG, "解出来的字节与原始 PNG 不一致");
        // ⚠️ 只认图片：文档里的非图片内嵌资源（嵌入的 Excel 之类）不进这个列表。
        assert!(image.media_type.starts_with("image/"));
    }

    /// 没有图片的文档：`images` 是 `Some(空)` 而**不是** `None`。
    ///
    /// ⚠️ 这两者必须分开：`Some(空)` = 「读过了，没有图」，
    /// `None` = 「这个格式读不出文档模型，**不知道**有没有图」（PDF）。
    /// 混成一个的后果是对一份满是插图的 PDF 说「这份文档没有图片」—— 那是编造事实。
    #[test]
    fn a_document_without_images_reports_an_empty_set_not_none() {
        let converted = convert(&chinese_docx(), Some("需求.docx")).expect("应当能转");
        let images = converted.images.expect("docx 读得出文档模型");
        assert_eq!(images.total, 0);
        assert!(images.items.is_empty());
        assert!(!images.truncated);
    }

    /// ⚠️★ 预算不够时**停在那张装不下的图上**，不去试后面更小的那些。
    ///
    /// 为什么这条重要：界面拿到 `items.len()` 会说「画布上只放了前 M 张」。
    /// 如果这里「跳过大的、接着装小的」，那句话就是**谎话**（装上的不是前 M 张）。
    #[test]
    fn the_image_budget_stops_at_the_first_one_that_does_not_fit() {
        let big = vec![0u8; 10];
        let small = vec![0u8; 1];
        let assets = [
            fake_asset("image/png", &big),
            fake_asset("image/png", &vec![0u8; 100]),
            fake_asset("image/png", &small),
        ];
        let refs: Vec<&anydoc::model::Asset> = assets.iter().collect();

        // 预算 11：第一张（10）装得下，第二张（100）装不下 → 停，**不试第三张**
        let (items, truncated) = cap_images(&refs, 11);
        assert!(truncated, "装不下就该报截断");
        assert_eq!(items.len(), 1, "第二张装不下就停，不该跳过它去装第三张");
        assert_eq!(items[0].bytes, 10);

        // 预算刚好够：一张都不截
        let (items, truncated) = cap_images(&refs[..1], 10);
        assert!(!truncated);
        assert_eq!(items.len(), 1, "预算正好等于大小应当装得下（边界不是越界）");

        // 预算 0：一张都不装
        let (items, truncated) = cap_images(&refs, 0);
        assert!(truncated);
        assert!(items.is_empty());

        // 空列表：没图也没截断
        let (items, truncated) = cap_images(&[], 100);
        assert!(!truncated && items.is_empty());
    }

    fn fake_asset(media_type: &str, bytes: &[u8]) -> anydoc::model::Asset {
        anydoc::model::Asset {
            id: anydoc::model::AssetId(0),
            media_type: media_type.to_owned(),
            origin_part: String::new(),
            bytes: bytes.to_vec(),
        }
    }

    /// 4×4 的纯红 PNG（73 字节）。
    ///
    /// ⚠️ 直接嵌字节而不是引一个图片编码库：测试只需要**一张真的 PNG**
    /// （有 PNG 魔数、能被认出来），为它多一个依赖不划算。
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x02, 0x00, 0x00, 0x00, 0x26,
        0x93, 0x09, 0x29, 0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xb8,
        0xa3, 0xa1, 0x01, 0x47, 0x0c, 0xc4, 0x71, 0x00, 0xf3, 0x03, 0x12, 0xc1, 0x23, 0xd3, 0x82,
        0x45, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    /// 现造一份**带内嵌图片**的中文 docx。
    ///
    /// ⚠️ 图片走 Word 的标准写法：`<w:drawing>` 里一个 `r:embed="rId2"`，
    /// 指向 `word/_rels/document.xml.rels` 里那条 image 关系，
    /// 字节放在 `word/media/image1.png`，并在 `[Content_Types].xml` 里声明 png。
    /// **四样缺一不可** —— 少一样（比如忘了 Content_Types）解析器就找不到这张图，
    /// 而用例会红在「应当找到 1 张图」上，正好指回这里。
    fn docx_with_image() -> Vec<u8> {
        use std::io::{Cursor, Write};

        use zip::write::SimpleFileOptions;

        const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

        const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

        const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>"#;

        const DRAWING: &str = r#"<w:p><w:r><w:drawing>
<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <wp:extent cx="457200" cy="457200"/>
  <wp:docPr id="1" name="图片 1"/>
  <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
    <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
        <pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
        <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
      </pic:pic>
    </a:graphicData>
  </a:graphic>
</wp:inline>
</w:drawing></w:r></w:p>"#;

        let document = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t xml:space="preserve">图之后还有一段文字</w:t></w:r></w:p>
{DRAWING}
</w:body></w:document>"#
        );

        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        for (name, body) in [
            ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
            ("_rels/.rels", RELS.as_bytes()),
            ("word/_rels/document.xml.rels", DOC_RELS.as_bytes()),
            ("word/document.xml", document.as_bytes()),
        ] {
            zip.start_file(name, options).expect("写 zip 条目");
            zip.write_all(body).expect("写 zip 内容");
        }
        zip.start_file("word/media/image1.png", options)
            .expect("写图片条目");
        zip.write_all(TINY_PNG).expect("写图片字节");
        zip.finish().expect("收尾 zip").into_inner()
    }
}
