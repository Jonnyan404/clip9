// 一条分享链接**能长什么样** —— 两个渲染器（网页 / 桌面）共用的那一份。
//
// ⚠️★ 铁律：**一个 import 都不许有**（理由与 `data/actions/pure.js` 那条完全一样）：
// 桌面端是一个**没有构建步骤**的普通页面，它只能 `import('./share-config.js')` 加载一个
// **自足**的模块。这里一旦出现 `@/…` 之类的别名，桌面侧会在运行时加载失败，
// 而失败的样子是「点分享没反应」。
//
// 这里装的是「有效期多少到多少、最多能用几次、能不能配密码」这些**判断**，
// 以及界面上那根滑块怎么摆 —— 网页版的 `ShareLinkButton.vue` 与桌面版的分享弹窗
// 必须给出**同一个答案**，否则「默认分享」在两端就是两件事。
//
// ⚠️★ 那四个上限必须与服务端一一对应（`rust/crates/core/src/share.rs` 的
// `DEFAULT_SHARE_TTL_SECONDS` / `MIN_` / `MAX_SHARE_TTL_SECONDS` / `MAX_SHARE_MAX_USES`）。
// 服务端也会夹一次，所以两边不一致**不报错** —— 症状是「用户填了 30 分钟，实际生效 15 分钟」，
// 或者反过来（这一侧拦下了服务端本来接受的输入）。由 `tools/share-limits-smoke.mjs` 盯着。
//
// ⚠️ 这个文件由 `tools/sync-action-catalog.mjs` **逐字节**拷到
// `rust/crates/desktop/ui/share-config.js`，那边同样跑这份判断。

/** 分享链接默认有效期（秒）—— 15 分钟。 */
export const SHARE_DEFAULT_TTL = 15 * 60;
/** 有效期下限（秒）—— 低于它会被**抬到**它，不是报错。 */
export const SHARE_MIN_TTL = 60;
/** 有效期上限（秒）—— 24 小时。 */
export const SHARE_MAX_TTL = 24 * 60 * 60;

/** `maxUses` 上限（0 = 不限次数）。对应 `share.rs` 的 `MAX_SHARE_MAX_USES`。
 *
 * ⚠️★ 这个常量在 2026-10-03 之前**根本不存在** —— 下面 `normalizeShareMaxUses` 里用了它、
 * 却从来没声明过。于是「分享面板里填了次数、点生成」会抛 `ReferenceError`，
 * 而表现是**点了没反应**（不填时 `Number('') === 0` 会在前面就返回，所以平时看不出来）。
 * ⇒ `tools/no-undef-smoke.mjs` 现在盯着这一整类：**用了、但从没声明过的标识符**。
 */
export const SHARE_MAX_USES_LIMIT = 1000;

/** 分钟 <-> 秒，供 UI 滑块使用。 */
export const SHARE_DEFAULT_TTL_MINUTES = Math.floor(SHARE_DEFAULT_TTL / 60);
export const SHARE_MIN_TTL_MINUTES = Math.floor(SHARE_MIN_TTL / 60);
export const SHARE_MAX_TTL_MINUTES = Math.floor(SHARE_MAX_TTL / 60);

/** 滑块旁边那几个档位（分钟）。
 *
 * ⚠️ 放在这一份里因为它们是**人工挑的**，不是算出来的：分开放的结果就是
 * 「手机上有 15 分钟可选、桌面上没有」这种说不清的不一致。
 * ⚠️ 最后一档恰好等于 `SHARE_MAX_TTL_MINUTES` —— 于是这一排里**没有**服务端会夹掉的选项。
 */
export const SHARE_TTL_PRESET_MINUTES = [15, 60, 360, 1440];

/** 把秒数夹进服务端那个区间。
 *
 * ⚠️ `0` / 空 / 非法值 → **默认**那一档（不是 0）—— 服务端也是这么归一化的
 *（`normalize_share_ttl`），所以不给服务端任何东西就等于要默认值。
 */
export function normalizeShareTTL(ttl) {
    const value = Number(ttl);
    if (!Number.isFinite(value) || value <= 0) {
        return SHARE_DEFAULT_TTL;
    }
    if (value < SHARE_MIN_TTL) {
        return SHARE_MIN_TTL;
    }
    if (value > SHARE_MAX_TTL) {
        return SHARE_MAX_TTL;
    }
    return Math.floor(value);
}

export function minutesToShareTTL(minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins)) {
        return SHARE_DEFAULT_TTL;
    }
    return normalizeShareTTL(Math.round(mins) * 60);
}

/** `0` = 不限次数。 */
export function normalizeShareMaxUses(maxUses) {
    const value = Number(maxUses);
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    if (value > SHARE_MAX_USES_LIMIT) {
        return SHARE_MAX_USES_LIMIT;
    }
    return Math.floor(value);
}

/** 把秒数说成一句人话。
 *
 * ⚠️ `t` 是**注入**的：两种客户端的字典不是一个（网页整套 i18n 键，桌面是按中文取的），
 * 但「什么时候用小时、什么时候用分钟、两样都有时怎么连」这个判断不需要分叉 ——
 * 写两份的结果是同一秒数在两端说成两种时长。
 */
export function formatShareDuration(seconds, t) {
    const total = normalizeShareTTL(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0 && minutes > 0) {
        return t('shareDurationHoursMinutes', { hours, minutes });
    }
    if (hours > 0) {
        return t('shareDurationHours', { hours });
    }
    return t('shareDurationMinutes', { minutes: Math.max(1, minutes) });
}

/** 滑块已走过的百分比（0-100），给那条自绘的进度条用。
 *
 * ⚠️ 为什么不是直接用原生 `range` 的样子：本来就是**两种**滑块样式撞在一起
 *（网页那边自己画了轨道）。作为一个函数放这里，是为了让「分钟 → 百分比」只有一种算法。
 */
export function shareTtlProgress(minutes) {
    const min = SHARE_MIN_TTL_MINUTES;
    const max = SHARE_MAX_TTL_MINUTES;
    const value = Number(minutes);
    if (!Number.isFinite(value) || max <= min) {
        return 0;
    }
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
