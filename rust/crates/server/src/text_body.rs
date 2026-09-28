//! `/text` 的请求体解析。
//!
//! 对应 Go `handler.go:507` 的 `readTextBody` 与 `handler.go:579` 的 `decodeTextBytes`。
//!
//! # 只认两种结构化形态，其余一律当纯文本
//!
//! ```text
//! application/json       -> {"content": "..."}
//! multipart/form-data    -> 表单字段 content
//! 其它（含不声明、含 urlencoded） -> 整个请求体就是正文（老客户端全走这条）
//! ```
//!
//! ⚠️ **`application/x-www-form-urlencoded` 刻意不认。** 它是 `curl --data-binary` 之类
//! 不带 `-H` 时的**默认** Content-Type，很多老调用方都这样发正文；一旦把它当表单解析，
//! `# 标题\n- 一条` 这种没有 `=` 的正文会解析出**空的 content 字段** ——
//! 不是报错，是**静默存成空串**。宁可不认它，让这些请求继续走「整个 body 是正文」那条老路。
//!
//! # 为什么要有前两条（JSON / 表单）
//!
//! 快捷指令用「获取 URL 内容」把**字符串变量**当请求体发出去时，字节会变成 UTF-16
//! （服务端收到的是 `j\0u\0s\0t\0`），而**结构化请求体**是按 UTF-8 序列化的。
//! 所以捷径侧只要把请求体类型换成这两个之一，编码问题就不存在了 —— 前提是服务端先收得下。

use axum::body::Bytes;

#[derive(Debug, thiserror::Error)]
pub enum TextBodyError {
    #[error("JSON 正文解析失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("表单正文解析失败: {0}")]
    Multipart(String),
}

/// 取正文。
///
/// 三种分支的判定只看 `Content-Type` 的 **media type 部分**（分号前的那个）。
pub async fn read_text_body(content_type: &str, body: Bytes) -> Result<String, TextBodyError> {
    match media_type_of(content_type).as_str() {
        "application/json" => {
            #[derive(serde::Deserialize)]
            struct Payload {
                #[serde(default)]
                content: String,
            }
            // ⚠️ `content` 缺失时按空串处理（Go 的 struct 解码也是零值），
            // 不报错 —— 报错会让「只发 `{}` 的客户端」拿到 400，而它只是想发个空条目。
            Ok(serde_json::from_slice::<Payload>(&body)?.content)
        }

        "multipart/form-data" => {
            let boundary = multer::parse_boundary(content_type)
                .map_err(|e| TextBodyError::Multipart(e.to_string()))?;
            // 整个 body 已经在内存里了（文本上限 4KB，没必要流式）。
            let stream =
                futures_util::stream::once(async move { Ok::<Bytes, std::io::Error>(body) });
            let mut multipart = multer::Multipart::new(stream, boundary);

            while let Some(field) = multipart
                .next_field()
                .await
                .map_err(|e| TextBodyError::Multipart(e.to_string()))?
            {
                if field.name() == Some("content") {
                    return field
                        .text()
                        .await
                        .map_err(|e| TextBodyError::Multipart(e.to_string()));
                }
            }
            // 没有 content 字段 → 空正文（Go 的 PostFormValue 也是这样）。
            Ok(String::new())
        }

        _ => Ok(decode_text_bytes(&body)),
    }
}

/// 取 `Content-Type` 的 media type 部分：截到分号为止、去空白、转小写。
///
/// ⚠️ Go 那边用的是 `mime.ParseMediaType`，解析失败时**回落成空串**（走「整个 body 是正文」）。
/// 这里用简单切分达到同样效果：格式坏掉的头（比如 `; charset=utf-8` 没有主类型）
/// 切出来是空串，同样落到默认分支。
fn media_type_of(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

#[derive(Clone, Copy)]
enum Endian {
    Little,
    Big,
}

/// 把请求体的字节还原成字符串。
///
/// # 为什么需要它
///
/// **快捷指令把字符串变量当请求体发出去时，字节是 UTF-16**（能直接看到 `A\x00B\x00C\x00`
/// 这种「字符后跟 NUL」的模式）。服务端一直按 UTF-8 读，于是中英文一起变乱码。
/// 客户端那边为了绕开它做过各种转换动作，而每一种都有自己的副作用 ——
/// 「从多信息文本获取 Markdown」会把正文里的 markdown 字符转义掉（`- 一条` → `\- 一条`）。
///
/// 这里只做一件事：**认出 UTF-16 就解码**，认不出原样当 UTF-8。三个信号依次看：
///
/// 1. **BOM**（`FF FE` / `FE FF`）—— 最可靠，见到就认；
/// 2. **隔位 NUL** —— ASCII 为主的正文编成 UTF-16 后每个字符后面跟一个 NUL；
/// 3. 整段**不是合法 UTF-8**、但按 UTF-16LE 解出来没有替换字符 —— 中文为主的正文靠这条
///    （CJK 在 UTF-16 里不含 NUL，信号 ② 对它完全无感）。
///
/// 误判风险：一段**合法 UTF-8** 永远不会走到 ③；而 GBK 之类解成 UTF-16 会满是替换字符，
/// 也过不了 ③。所以**宁可漏认，不会把好好的 UTF-8 弄坏**。
///
/// ⚠️ 和 Go 的一处差异：Go 的 `string(b)` 保留非法字节，Rust 的 `String` 必须是合法 UTF-8，
/// 所以最后一步用 `from_utf8_lossy`。**端到端行为一致** —— 因为 Go 那边的非法字节
/// 一旦被 `json.Marshal` 序列化也会变成 U+FFFD。
#[must_use]
pub fn decode_text_bytes(b: &[u8]) -> String {
    if b.len() >= 2 {
        if b[0] == 0xFF && b[1] == 0xFE {
            return decode_utf16(&b[2..], Endian::Little);
        }
        if b[0] == 0xFE && b[1] == 0xFF {
            return decode_utf16(&b[2..], Endian::Big);
        }
    }

    if b.len() >= 4 && b.len().is_multiple_of(2) {
        let (mut even_zeros, mut odd_zeros) = (0usize, 0usize);
        for (i, c) in b.iter().enumerate() {
            if *c == 0 {
                if i.is_multiple_of(2) {
                    even_zeros += 1;
                } else {
                    odd_zeros += 1;
                }
            }
        }
        // ② 隔位 NUL：一半以上的奇数位是 NUL 且偶数位没有 NUL → 小端
        if odd_zeros >= b.len() / 4 && even_zeros == 0 {
            return decode_utf16(b, Endian::Little);
        }
        if even_zeros >= b.len() / 4 && odd_zeros == 0 {
            return decode_utf16(b, Endian::Big);
        }
        // ③ 不是合法 UTF-8，但按 UTF-16LE 解得干净 → 认它
        if std::str::from_utf8(b).is_err() {
            let decoded = decode_utf16(b, Endian::Little);
            if !decoded.contains(char::REPLACEMENT_CHARACTER) {
                return decoded;
            }
        }
    }

    String::from_utf8_lossy(b).into_owned()
}

fn decode_utf16(b: &[u8], endian: Endian) -> String {
    // `as_chunks::<2>()` 会丢掉末尾那个落单的字节（和 `chunks_exact` 一样），
    // 这正是要的：奇数长度的输入不该 panic。
    let mut units: Vec<u16> = b
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| match endian {
            Endian::Little => u16::from_le_bytes(*c),
            Endian::Big => u16::from_be_bytes(*c),
        })
        .collect();

    // 末尾常带一个孤立的 NUL（发出去的字符串结尾），去掉它别在正文尾巴上多一个字符。
    if units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }
    fn utf16be(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_be_bytes).collect()
    }

    #[tokio::test]
    async fn json_branch_reads_the_content_field() {
        let body = Bytes::from_static(br#"{"content":"hello\nworld"}"#);
        let got = read_text_body("application/json", body).await.unwrap();
        assert_eq!(got, "hello\nworld");
    }

    /// ⚠️ `content` 缺失时给空串，不报错 —— Go 的 struct 解码也是零值。
    #[tokio::test]
    async fn json_without_content_is_an_empty_string_not_an_error() {
        let got = read_text_body("application/json", Bytes::from_static(b"{}"))
            .await
            .unwrap();
        assert_eq!(got, "");
    }

    #[tokio::test]
    async fn json_that_is_broken_is_an_error() {
        assert!(
            read_text_body("application/json", Bytes::from_static(b"{oops"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn multipart_branch_reads_the_content_field() {
        let body = concat!(
            "--BOUND\r\n",
            "Content-Disposition: form-data; name=\"content\"\r\n\r\n",
            "# 标题\n- 一条\r\n",
            "--BOUND--\r\n"
        );
        let got = read_text_body(
            "multipart/form-data; boundary=BOUND",
            Bytes::from(body.as_bytes().to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(got, "# 标题\n- 一条");
    }

    /// ⚠️★ 这条是整段代码里最贵的：`urlencoded` **必须**走「整个 body 是正文」。
    /// 当表单解析的话，`# 标题\n- 一条` 里没有 `=`，会**静默存成空串**。
    #[tokio::test]
    async fn urlencoded_is_deliberately_treated_as_plain_text() {
        let raw = "# 标题\n- 一条";
        let got = read_text_body(
            "application/x-www-form-urlencoded",
            Bytes::from(raw.as_bytes().to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(got, raw, "urlencoded 不能被当表单解析");

        // 就算它长得像个表单，也照样整段当正文 —— 因为判定只看 Content-Type。
        let looks_like_form = "content=abc&other=1";
        let got = read_text_body(
            "application/x-www-form-urlencoded",
            Bytes::from(looks_like_form.as_bytes().to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(got, looks_like_form);
    }

    #[tokio::test]
    async fn missing_content_type_is_plain_text() {
        let got = read_text_body("", Bytes::from_static("just text".as_bytes()))
            .await
            .unwrap();
        assert_eq!(got, "just text");
    }

    /// 带参数、大小写、多余空白的 Content-Type 都要认出来。
    #[tokio::test]
    async fn media_type_parsing_ignores_params_and_case() {
        assert_eq!(
            media_type_of("application/json; charset=utf-8"),
            "application/json"
        );
        assert_eq!(media_type_of("APPLICATION/JSON"), "application/json");
        assert_eq!(media_type_of("  text/plain  ; charset=UTF-8"), "text/plain");
        assert_eq!(media_type_of("garbage"), "garbage");
        assert_eq!(media_type_of(""), "");
    }

    // ── UTF-16 嗅探 ───────────────────────────────────────────────────

    #[test]
    fn bom_le_decodes() {
        let mut b = vec![0xFF, 0xFE];
        b.extend(utf16le("hello"));
        assert_eq!(decode_text_bytes(&b), "hello");
    }

    #[test]
    fn bom_be_decodes() {
        let mut b = vec![0xFE, 0xFF];
        b.extend(utf16be("hello"));
        assert_eq!(decode_text_bytes(&b), "hello");
    }

    /// 信号 ②：ASCII 为主的正文编成 UTF-16LE 后，奇数位全是 NUL。
    #[test]
    fn alternate_nulls_le_decodes() {
        let b = utf16le("ABC");
        assert_eq!(b, [0x41, 0x00, 0x42, 0x00, 0x43, 0x00]);
        assert_eq!(decode_text_bytes(&b), "ABC");
    }

    /// 信号 ③：CJK 在 UTF-16 里**不含 NUL**，信号 ② 对它完全无感，
    /// 只能靠「不是合法 UTF-8 但 UTF-16LE 解得干净」认出来。
    #[test]
    fn cjk_utf16_le_without_nulls_decodes_via_signal_three() {
        let b = utf16le("岚的剪贴板");
        assert!(!b.contains(&0), "这条测试的前提就是它不含 NUL");
        assert_eq!(decode_text_bytes(&b), "岚的剪贴板");
    }

    /// ⚠️ 反过来的保护：**合法 UTF-8 绝不能被误判成 UTF-16**。
    #[test]
    fn valid_utf8_is_never_misdetected() {
        for s in ["hello", "岚🪶", "# 标题\n- 一条", "a=1&b=2", ""] {
            assert_eq!(decode_text_bytes(s.as_bytes()), s, "被误判了: {s:?}");
        }
    }

    /// GBK 之类解成 UTF-16 会满是替换字符 → 过不了信号 ③，原样返回（不弄坏）。
    #[test]
    fn gbk_like_bytes_are_left_alone() {
        // "中文" 的 GBK 编码
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        let got = decode_text_bytes(&gbk);
        assert!(
            !got.is_empty(),
            "不该解出空串 —— 要么原样（带替换字符），要么解出东西"
        );
    }

    /// 末尾那个孤立的 NUL 要去掉，否则正文尾巴上会多一个字符。
    ///
    /// ⚠️ 必须**带 BOM** 才测得到：不带 BOM 时，结尾那两个 NUL 会在**偶数位**上多出
    /// 一个 NUL，于是信号 ② 的「偶数位没有 NUL」条件不成立，整段落回原样输出。
    /// **Go 那边一模一样**（同一套判定），所以这不是 bug，是这条路径的前提。
    /// 真实场景里快捷指令的输出是带 BOM 的，走的就是这条。
    #[test]
    fn trailing_nul_is_trimmed_after_a_bom() {
        let mut b = vec![0xFF, 0xFE];
        b.extend(utf16le("hi"));
        b.extend([0x00, 0x00]);
        assert_eq!(decode_text_bytes(&b), "hi");
    }

    /// 不带 BOM 的「ASCII + 结尾 NUL」**认不出来** —— 照抄 Go 的行为，别去「修」它。
    #[test]
    fn ascii_with_a_trailing_nul_but_no_bom_is_left_as_is() {
        let mut b = utf16le("hi");
        b.extend([0x00, 0x00]);
        assert_eq!(decode_text_bytes(&b), "h\0i\0\0\0");
    }

    /// 奇数长度 / 太短 的输入不该 panic。
    #[test]
    fn odd_length_input_does_not_panic() {
        for len in 0..8 {
            let b: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let _ = decode_text_bytes(&b);
        }
    }
}
