/**
 * 白板文档的**序列化**：画布 ↔ `.excalidraw` JSON。
 *
 * 纯函数、不碰 DOM、不 import Excalidraw —— 所以 `node` 能直接跑它
 * （`web/scripts/check-whiteboard-plan.mjs` 就靠这条）。
 *
 * # 为什么白板是「一条文件条目」
 *
 * `dev-docs/specs/whiteboard-anydoc-integration.md` §2.4：白板 JSON 存 `uploads/`，
 * 于是**分享链接、删除、过期清理、多设备 WS 同步、房间鉴权全部免费继承** ——
 * 不用为它新造一套实体、一套权限、一套清理任务。
 * 这也是 `board-mode.md` §1 记着的教训：**看板是同一批条目的一个视图，不是第二份数据**。
 *
 * ⚠️ 代价（要认）：服务端**没有「更新一个文件」的接口**（只有上传与删除），
 * 所以「保存」= **新建一条**。同一个白板存三次就是三条文件条目 ——
 * 房间里会看到三张卡片。这是本切片的已知取舍，不是 bug。
 * 真要「就地覆盖」，得先有 `PUT /file/{uuid}`，那是另一件事
 * （而且它会把「分享出去的链接指向的内容被改掉」变成可能，要一起想清楚）。
 *
 * # 写出去的形状
 *
 * 照 Excalidraw 的 `.excalidraw` 约定：
 *
 * ```json
 * { "type": "excalidraw", "version": 2, "source": "clip9",
 *   "elements": [...], "appState": {...}, "files": {} }
 * ```
 *
 * ⚠️ `type` 必须是字面量 `"excalidraw"` —— 别的 Excalidraw 实例（以及它自己的
 * 「打开文件」）就是靠这个字段认的。少了它，导出的文件在任何地方都打不开，
 * 而**写的时候不会报错**。
 *
 * ⚠️ `version: 2` 是当前 schema 版本，**不是 clip9 的版本号**。
 */

/** 白板文件的扩展名（小写、带点）。 */
export const WHITEBOARD_EXT = '.excalidraw';

/** Excalidraw 用来认「这是不是一份画布」的魔数字段。 */
const MAGIC_TYPE = 'excalidraw';

/**
 * 从画布元素造一份可保存的文档。
 *
 * ⚠️ 只留 `viewBackgroundColor` 一个 `appState` 字段：其余（当前选中的工具、
 * 滚动位置、协作状态）都是**这一次会话的**，存下来会让别人打开时莫名其妙地
 * 处于你上次的工具状态里。`viewBackgroundColor` 是唯一一个「属于这份文档」的。
 */
export function serializeWhiteboard(elements: readonly unknown[], viewBackgroundColor = 'transparent'): string {
    return JSON.stringify(
        {
            type: MAGIC_TYPE,
            version: 2,
            source: 'clip9',
            elements,
            appState: { viewBackgroundColor },
            files: {},
        },
        null,
        // ⚠️ 不缩进：这是机器读的文件，缩进会让体积翻几倍（画布 JSON 很容易上 MB），
        // 而人要看的话界面里有画布本身，不需要去读 JSON。
    );
}

export interface ParsedWhiteboard {
    elements: unknown[];
    viewBackgroundColor: string;
}

/**
 * 读一份白板文档。**认不出就回 `null`**，不抛异常。
 *
 * ⚠️★ 判据只有两条：`type` 是 `"excalidraw"`、`elements` 是数组。
 * 多校验一步（比如逐个元素查字段）只会让**将来某个 Excalidraw 版本**加的字段
 * 把老文件判成坏的 —— 而那正是「读得宽松、写得严格」这条规矩要避免的事。
 *
 * ⚠️ 反过来，**不能**只 catch `JSON.parse` 就当读好了：一份合法的 JSON
 * （比如 `{"hello":1}`）会解析成功，然后 `elements` 是 `undefined`，
 * 画布被清空而**用户以为加载成功了**。
 */
export function parseWhiteboard(text: string): ParsedWhiteboard | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const doc = raw as { type?: unknown; elements?: unknown; appState?: unknown };
    if (doc.type !== MAGIC_TYPE || !Array.isArray(doc.elements)) {
        return null;
    }
    const appState = (doc.appState ?? {}) as { viewBackgroundColor?: unknown };
    return {
        elements: doc.elements,
        viewBackgroundColor:
            typeof appState.viewBackgroundColor === 'string' ? appState.viewBackgroundColor : 'transparent',
    };
}

/** 这个文件名看起来是不是一份白板。 */
export function isWhiteboardName(name: string | undefined | null): boolean {
    return String(name ?? '')
        .toLowerCase()
        .endsWith(WHITEBOARD_EXT);
}

/**
 * 造一个白板文件名：`<前缀>-YYYYMMDD-HHmm.excalidraw`。
 *
 * ⚠️ 前缀由调用方给（来自 i18n）而不是写死中文：这个前端有四种语言，
 * 写死的话英文/日文用户会在一堆文件里看到一串他们看不懂的字。
 *
 * ⚠️ 时间用**本地时间**（`getFullYear()` 那套）而不是 `toISOString()`：
 * 后者是 UTC，东八区晚上 8 点存的白板会显示成当天中午 —— 用户按文件名排序时对不上。
 *
 * ⚠️ 用 `-` 分隔而不是空格或冒号：文件名会进 URL（`/file/<uuid>/<name>`），
 * 冒号在部分平台/工具里是非法字符，空格会被编码成 `%20` 看着很脏。
 */
export function whiteboardFileName(prefix: string, now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    // ⚠️ 前缀里的空格、斜杠、冒号全换成 `-`：用户在别的语言下可能给一个带空格的前缀，
    // 而文件名里的 `/` 是一个**路径分隔符**（服务端存的是裸 uuid，不受影响，
    // 但它会进 URL 的名字那一段，不值得冒这个险）。
    const safePrefix = prefix.trim().replace(/[\s/\\:]+/g, '-') || 'canvas';
    return `${safePrefix}-${stamp}${WHITEBOARD_EXT}`;
}
