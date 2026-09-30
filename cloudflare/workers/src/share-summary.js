// 分享链接用到的几个纯函数：摘要、大小、有效期文案。
//
// 单独一个模块是因为它们同时被两处需要（share.js 写记录列表的名称、share-landing.js
// 渲染 OG 卡片），而 share-landing.js 已经依赖 share.js —— 放在任何一边都会成环。
// 与 Go 侧 share_landing.go 里那几个同名函数保持一致。

export const SHARE_TITLE_LIMIT = 80;
export const SHARE_DESC_LIMIT = 160;
export const SHARE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SHARE_NAME_LIMIT = 60;

export function truncateRunes(value, limit) {
  const text = String(value == null ? '' : value).trim();
  const chars = [...text];
  if (limit <= 0 || chars.length <= limit) {
    return text;
  }
  return `${chars.slice(0, limit).join('').trim()}…`;
}

/**
 * 卡片/记录列表里给一段文本取「一眼能认出来」的那一行。
 *
 * 刻意只取第一行有内容的行：正文可能含账号、验证码、完整密码 —— 摘要少搬一点，
 * 第三方预览缓存里就少留一点（那段缓存删不掉，见 share-landing.js 的说明）。
 *
 * ⚠️★ 下面那个字符类里的 `-` **必须转义**（`\\-`），不能写成 `[#>*-·|\s]`。
 *
 * 原因是 JS 的字符类里 `-` 夹在两个字符之间会被解析成**范围**：`[#>*-·]` 里的 `*`(U+002A)
 * 与 `·`(U+00B7) 之间那条 `-` 不是字面量，而是「U+002A 到 U+00B7」——
 * ⚠️ 而 **ASCII 的数字（U+0030–U+0039）与大小写字母（U+0041–U+005A / U+0061–U+007A）
 * 全部落在这个区间里**。于是「去掉行首行尾的 Markdown 装饰符」实际变成了
 * 「吃掉行首行尾的所有字母数字」：
 *
 *   `123`               → `''`（整行吃光 → 落地页退回「有人分享了一段文本」）
 *   `hello`             → `''`（同上）
 *   `password: hunter2` → `''`（同上）
 *   `hello 世界`         → `'世界'`（开头的 ASCII 被吃掉）
 *   `你好 123456`        → `'你好'`（结尾的数字被吃掉）
 *   `招行 APP 登录密码`  → 正常 —— **汉字（U+4E00+）不在那个范围里**，
 *                          削到第一个汉字就停住了
 *
 * ⚠️★ 这正是它长期没被发现的原因：中文内容看不出问题，而测试夹具的首尾又恰好都是中文。
 * 2026-10-01 由 Jonny 报「发短文本比如 123，只显示有人分享了一段内容」才发现。
 * ⚠️ 同一个函数还管着**分享记录列表的名字**（`share.js`），所以那边纯 ASCII 的记录
 * 名字以前也是空的。
 *
 * ⚠️ 这边的语义是**首尾都削**（对应 Go 侧那句 `strings.Trim(clean, "#>*-·|")`）；
 * Rust 侧的 `first_summary_line` 用 `trim_start_matches`，**只削行首** ——
 * 那个偏差是「少削一点」（不会吃内容），所以这一轮没跟着改。
 */
export function firstSummaryLine(text, limit = SHARE_TITLE_LIMIT) {
  for (const line of String(text == null ? '' : text).split('\n')) {
    let clean = line.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/^[#>|\-*·\s]+/, '').replace(/[#>|\-*·\s]+$/, '').trim();
    if (clean) {
      return truncateRunes(clean, limit);
    }
  }
  return '';
}

export function formatShareSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value}B` : `${size.toFixed(1)}${units[unit]}`;
}

export function shareExpiryNote(exp) {
  const value = Number(exp || 0);
  if (value <= 0) {
    return '';
  }
  const remaining = value - Math.floor(Date.now() / 1000);
  if (remaining <= 0) {
    return '已过期';
  }
  if (remaining < 3600) {
    return `${Math.ceil(remaining / 60)} 分钟内有效`;
  }
  return `${Math.ceil(remaining / 3600)} 小时内有效`;
}

export function joinShareMeta(siteName, ...parts) {
  const kept = parts.filter((part) => String(part || '').trim() !== '');
  if (!kept.length) {
    return `通过 ${siteName} 分享，打开即可查看。`;
  }
  return kept.join(' · ');
}

export function isPreviewableImageName(name) {
  const lower = String(name || '').toLowerCase().trim();
  const idx = lower.lastIndexOf('.');
  if (idx < 0) {
    return false;
  }
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(lower.slice(idx + 1));
}
