//! `format` 组：JSON 美化 / 压行。
//!
//! ⚠️ 这两条**不走 `serde_json::Value`**：`Value` 的 `Map` 默认是 `BTreeMap`，
//! 会把键按字典序重排，而 Go 用的是 `json.Indent` / `json.Compact` —— 它们**原样保留键顺序**，
//! 前端 `JSON.stringify` 也是。演示一下这个差别：`{"b":1,"a":2}` 经 `Value` 一趟会变成
//! `{"a":2,"b":1}`，用户马上就能看出「这东西动了我的 JSON」。
//!
//! 所以流程是：**先校验**（`serde_json` 只当语法检查器，结果丢掉），**再自己重排空白**。

use serde_json::Value;

use crate::error::ActionError;
use crate::registry::{ActionContext, Params};

// ⚠️ `pub(crate)`：调用它的是**兄弟模块** `registry`，分组模块自己不对外暴露。
pub(crate) fn run(
    id: &str,
    input: &str,
    _params: &Params,
    _ctx: &ActionContext,
) -> Option<Result<String, ActionError>> {
    Some(match id {
        "format.json.pretty" => json_pretty(input),
        "format.json.min" => json_min(input),
        _ => return None,
    })
}

/// 校验是不是合法 JSON。**只用来判断合法性**，值不参与后续处理（理由见模块文档）。
///
/// ⚠️ 已知差异：`serde_json` 对**超出 f64 范围的数字**会直接报错，而 Go 的
/// `json.Indent` / `json.Compact` 只看语法、不看数值范围。所以 `1e400` 这种输入
/// 在这边会被判成「不是合法的 JSON」，在 Go 那边会被美化出来。现实中没人会拿它当 JSON 使，
/// 但差异要写在这儿 —— 与其假装没有，不如让它下次被问到时一眼可见。
fn check_json(source: &str) -> Result<(), ActionError> {
    if source.is_empty() {
        return Err(invalid("不是合法的 JSON: 内容是空的"));
    }
    serde_json::from_str::<Value>(source)
        .map(|_| ())
        .map_err(|e| invalid(format!("不是合法的 JSON: {e}")))
}

fn invalid(message: impl Into<String>) -> ActionError {
    ActionError::InvalidInput(message.into())
}

/// 与前端同一条约定：**结果和原文一样就算失败**（报错，而不是把原文回给你）。
///
/// 理由：定时任务是无人值守的，「点了没反应的按钮」比没有这个按钮更糟 ——
/// 用户分不清是「没可压的」还是「功能坏了」。同理，链上后一步也会看不出发生过什么。
fn reject_noop(produced: &str, original: &str, message: &str) -> Result<String, ActionError> {
    if produced == original {
        return Err(invalid(message));
    }
    Ok(produced.to_owned())
}

/// 按 Go `json.Indent` 的规则重排：2 空格缩进、`"key": value`、数组/对象每项一行，
/// **空容器不展开**（`{}` 就是 `{}`），字符串里的空白一个都不动。
fn json_pretty(input: &str) -> Result<String, ActionError> {
    let source = input.trim();
    check_json(source)?;

    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len() + source.len() / 2);
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    let next_significant = |from: usize| chars[from..].iter().copied().find(|c| !c.is_whitespace());

    for (index, &ch) in chars.iter().enumerate() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '{' | '[' => {
                out.push(ch);
                depth += 1;
                // ⚠️ 空容器（`{}` / `[]`）**不展开** —— Go 会先看下一个有效字符是不是配对的括号。
                if !matches!(next_significant(index + 1), Some('}') | Some(']')) {
                    push_newline_indent(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                // 同理：空容器的闭合括号紧贴着开括号，不换行。
                let previous = chars[..index]
                    .iter()
                    .rev()
                    .copied()
                    .find(|c| !c.is_whitespace());
                if !matches!(previous, Some('{') | Some('[')) {
                    push_newline_indent(&mut out, depth);
                }
                out.push(ch);
            }
            ',' => {
                out.push(ch);
                push_newline_indent(&mut out, depth);
            }
            ':' => out.push_str(": "),
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }

    reject_noop(&out, source, "已经是美化过的 JSON")
}

/// 按 Go `json.Compact` 的规则：去掉字符串**外面**的所有空白。
///
/// ⚠️ 顺序是「先校验、再压」而不是「边压边校验」：压坏了才发现语法不对的话，
/// 报出来的位置是压过之后的位置，对着原文根本找不到。
fn json_min(input: &str) -> Result<String, ActionError> {
    let source = input.trim();
    check_json(source)?;

    let mut out = String::with_capacity(source.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in source.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            c if c.is_whitespace() => {}
            c => out.push(c),
        }
    }

    reject_noop(&out, source, "已经是一行，压不动了")
}

fn push_newline_indent(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}
