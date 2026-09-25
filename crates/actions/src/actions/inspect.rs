//! `inspect` 组：校验类 / 时间戳类。
//!
//! 目前只接了 `inspect.sha256`；时间戳两条还在 [`crate::registry::not_yet_implemented`] 里
//! （它们要和 `ctx.now` 的时区打交道，单独一批做）。

use sha2::{Digest, Sha256};

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
        // 小写十六进制、无分隔（Go 是 `hex.EncodeToString(sum[:])`）。
        "inspect.sha256" => Ok(format!("{:x}", Sha256::digest(input.as_bytes()))),
        _ => return None,
    })
}
