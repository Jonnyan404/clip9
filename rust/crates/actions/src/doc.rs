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

use crate::error::ActionError;

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

/// 文档字节 → Markdown。
///
/// `filename` 只用来**兜底**：CSV 没有签名（任何字节序列都可能是合法 CSV），
/// 不给出名字就认不出来。其余格式都从内容里嗅探，改名也照样能转。
///
/// # 格式判定：**内容优先、扩展名兜底**
///
/// 与上游 [`anydoc::to_markdown`] 同一条规矩（`Format::from_bytes` 优先，
/// `Format::from_path` 兜底）。理由：扩展名是**用户可改的**、内容不是 ——
/// 一份 `.txt` 里装着 docx，按内容转是对的；反过来按扩展名硬套只会得到
/// 「malformed」这种看不懂的报错。
///
/// # Errors
///
/// 认不出格式、文档加密、结构损坏、超出安全上限、以及**扫描件需要 OCR**
/// 都会回 [`ActionError::InvalidInput`]（文案是给人看的中文，与 `error.rs` 的约定一致）。
/// ⚠️ **空的转换结果也算失败**（见函数体末尾那段）：那是「看着成功、其实什么都没拿到」。
pub fn to_markdown(bytes: &[u8], filename: Option<&str>) -> Result<String, ActionError> {
    if bytes.is_empty() {
        return Err(invalid("文件是空的，没有内容可转"));
    }

    let format = Format::from_bytes(bytes).or_else(|| {
        filename
            .and_then(extension_of)
            .and_then(Format::from_extension)
    });

    let markdown = anydoc::to_markdown_bytes(bytes, format).map_err(explain)?;

    // ⚠️ 空结果**不能**当成功：一份只有图片的 docx、或一个空表格，转出来就是空串。
    // 把它当成功会让调用方铺出一张空白白板，而用户以为「转好了」。
    // 这与 `format.rs` 的 `reject_noop` 同源 —— 静默的「成功」比明确的失败糟得多。
    if markdown.trim().is_empty() {
        return Err(invalid(
            "没能从这份文档里提取出正文（可能是纯图片或空文档）",
        ));
    }

    Ok(markdown)
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
}
