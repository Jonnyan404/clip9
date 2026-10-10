/**
 * 白板的**本地草稿**：自动存、刷新自动恢复。
 *
 * # 它解决什么
 *
 * 没有它的时候，刷新一下画布就空了 —— 内容其实还在（`保存到房间` 把它写成了房间里的一条
 * 文件条目），但**用户得自己点「打开」把它选回来**。那两件事在用户眼里是同一件：
 * 「我的东西没了」。而白板是那种会让人画上十几分钟的东西。
 *
 * # 与服务端那份的分工
 *
 * | | 本地草稿（这里） | 房间里的文件条目 |
 * |---|---|---|
 * | 什么时候写 | 画布一变就写（防抖） | 用户点「保存到房间」 |
 * | 存哪 | 这台设备的 `localStorage` | 服务端 `uploads/` |
 * | 谁能看到 | 只有这台设备 | 房间里的所有人 + 分享链接 |
 * | 刷新后 | **自动恢复** | 要手动「打开」 |
 *
 * ⚠️★ 两者**不是替代关系**，别把草稿当成「已经保存了」：草稿换台设备就没有，
 * 也分享不出去。所以「保存到房间」那个按钮仍然必须由用户主动点。
 *
 * # ⚠️ 为什么是 `localStorage` 而不是 `IndexedDB`，以及它的代价
 *
 * `localStorage` 简单、同步、到处都有。代价有两条，都要认：
 *
 * 1. **容量小**（多数浏览器每个源 5 MB 左右），而且**同步写会卡主线程** ——
 *    所以这里把上限压在 [`DRAFT_MAX_BYTES`]（2 MB），并把「装不下」变成一个
 *    **看得见的结果**（`'too-big'`）而不是静默失败。带大图的画布会撞上它。
 * 2. 一份草稿是**一整个字符串**，没有增量写。
 *
 * ⚠️ 真到了「带图的画布普遍撞上限」那天，正确的做法是换 `IndexedDB`
 * （异步、配额按磁盘算），而不是把这个上限调大 —— 调大只会让主线程卡顿
 * 从「偶尔」变成「每次」。
 *
 * # 为什么按房间分开存
 *
 * 不同房间是**不同的白板**。共用一个键的话，切房间再刷新会把 A 房间的画布
 * 恢复进 B 房间，而用户完全不知道发生了什么。
 */

/** `localStorage` 的键前缀。⚠️ 带上房间名，见模块文档。 */
const DRAFT_PREFIX = 'canvasDraft:';

/**
 * 一份草稿最多多少字节（按**字符串长度**算，不是字节）。
 *
 * ⚠️ 取 2 MB 而不是贴着 `localStorage` 的 5 MB：同步写 5 MB 会让主线程卡住肉眼可见的
 * 一段时间，而画布变化是**频繁**的（防抖后仍然几秒一次）。
 * 宁可少存一点、并且如实告诉用户「没存下」，也不要让界面一顿一顿的。
 */
export const DRAFT_MAX_BYTES = 2 * 1024 * 1024;

/** 这个房间的草稿键。⚠️ 房间名为空（还没连上）时也给一个稳定的键，别拼出 `canvasDraft:`。 */
export function draftKey(room: string): string {
    return `${DRAFT_PREFIX}${room || 'default'}`;
}

/**
 * 这份草稿值不值得存。**纯函数**，所以 `node` 能直接测它。
 *
 * ⚠️ 空内容**不存**（`''` 存下去只会让下次刷新「恢复」出一张空画布，
 * 还会把上一份真草稿覆盖掉）。
 * ⚠️ 超上限**不存**，由调用方把 `'too-big'` 变成一句给用户看的话 ——
 * **绝不静默**：用户以为「刷新丢不了」，而实际上没存，那是最坏的一种。
 */
export function shouldKeepDraft(text: string): boolean {
    return text.length > 0 && text.length <= DRAFT_MAX_BYTES;
}

/** 读这个房间的草稿。没有 / 读不出来（隐私模式、被禁用）都回 `null`。 */
export function readDraft(room: string): string | null {
    try {
        return localStorage.getItem(draftKey(room));
    } catch {
        // ⚠️ 隐私模式下 `localStorage` 可能直接抛。草稿是**尽力而为**的东西，
        // 读不到就当作没有 —— 绝不能因为它把整个白板模式搞崩。
        return null;
    }
}

/**
 * 写这个房间的草稿。
 *
 * 返回 `'too-big'` 时**没有**写进去（调用方要据此提示用户），
 * 返回 `'unavailable'` 时是环境不允许（隐私模式 / 配额满）。
 */
export function writeDraft(room: string, text: string): 'ok' | 'too-big' | 'unavailable' {
    if (!shouldKeepDraft(text)) {
        return 'too-big';
    }
    try {
        localStorage.setItem(draftKey(room), text);
        return 'ok';
    } catch {
        return 'unavailable';
    }
}

/** 清掉这个房间的草稿（「清空画布」时要调 —— 否则刷新会把用户刚删掉的东西恢复回来）。 */
export function clearDraft(room: string): void {
    try {
        localStorage.removeItem(draftKey(room));
    } catch {
        // 同上：草稿是尽力而为的。
    }
}
