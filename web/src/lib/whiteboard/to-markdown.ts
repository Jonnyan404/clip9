/**
 * 画布 → Markdown 大纲。
 *
 * 纯函数、不碰 DOM、不 import Excalidraw —— 所以 `node` 能直接跑它
 * （`web/scripts/check-whiteboard-plan.mjs` 靠这条）。
 *
 * # 它是「文档 → 白板」的反向
 *
 * 正向（`markdown-plan.ts`）把文档铺成树；这一条把树收回去。
 * 于是「导入 → 在白板上改 → 导出」这条闭环能走通 ——
 * 而中间那步「改」正是白板存在的意义（不然用户直接改原文档就行）。
 *
 * ⚠️★ **层级靠「连线的绑定」还原，不靠坐标。**
 *
 * 2026-10-11 实测：`excalidraw-adapter` 原来画出来的连线**没有绑定**
 * （`startBinding` 是 `null`），于是「拖动一个节点，连线留在原地」——
 * 那既是画布上的真 bug，也让**按坐标猜父子**变成不可靠（用户挪过就不准了）。
 * 绑定修好之后，`arrow.startBinding.elementId` 就是**稳的**父子依据。
 *
 * # ⚠️ 它是**有损**的，而且丢的东西要说出来
 *
 * 方案 §D6 声明过「往返有损」。具体丢这些，**调用方必须如实告诉用户**：
 * - **手绘/自由布局**：没有绑定、也没有文字的元素 → 收不进去；
 * - **图片**：Markdown 里放不进去（没有可引用的 URL），只报个数；
 * - **同一层里的左右顺序**：按视觉位置（先上后左）排，那是**猜的**，不是原始顺序。
 */

/** 从画布元素里认出来的一「块」。 */
interface CanvasNode {
    id: string;
    text: string;
    /**
     * 这块原本是什么（`heading` / `item` / `card`），从元素的 `customData` 读。
     *
     * ⚠️★ 不读它的话**正文段落会被导出成标题** —— 画布上「标题」和「正文卡片」
     * 都是一个矩形加一段字，光看元素分不出来。2026-10-12 实测踩到。
     * 缺失时按 `heading` 处理（用户手画的框没有这个字段）。
     */
    kind: string;
    /** 画布上的位置，只用来排**同一层的先后**（先上后左）。 */
    y: number;
    x: number;
}

/**
 * 画布元素 → Markdown 大纲。
 *
 * 返回的字符串**保证以换行结尾**（没有内容时是空串）。
 */
export function elementsToMarkdown(elements: readonly unknown[]): string {
    const list = (elements ?? []) as RawElement[];

    // ── ① 找「块」 ────────────────────────────────────────────────────
    // ⚠️ 被容器绑定的文字元素**不能单独算一块**（它的文字属于那个容器），
    // 所以先收集一遍「谁是别人的 label」。
    const labelIds = new Set<string>();
    for (const element of list) {
        for (const bound of element.boundElements ?? []) {
            if (bound?.type === 'text' && typeof bound.id === 'string') {
                labelIds.add(bound.id);
            }
        }
    }
    const byId = new Map<string, RawElement>();
    for (const element of list) {
        if (typeof element.id === 'string') {
            byId.set(element.id, element);
        }
    }

    const nodes = new Map<string, CanvasNode>();
    for (const element of list) {
        if (element.isDeleted || typeof element.id !== 'string') continue;

        if (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') {
            // 容器的文字在被绑定的那个 text 元素里（见上面的 `labelIds`）。
            const label = (element.boundElements ?? []).find((b) => b?.type === 'text');
            const labelId = typeof label?.id === 'string' ? label.id : '';
            const text = String(byId.get(labelId)?.text ?? '').trim();
            if (text) {
                const kind = (element.customData as { clip9Kind?: unknown } | undefined)?.clip9Kind;
                nodes.set(element.id, {
                    id: element.id,
                    text,
                    kind: typeof kind === 'string' ? kind : 'heading',
                    x: number(element.x),
                    y: number(element.y),
                });
            }
            continue;
        }

        if (element.type === 'text' && !labelIds.has(element.id)) {
            // ⚠️ 独立的文字元素也算一块 —— 用户可能自己往上贴了说明。
            const text = String(element.text ?? '').trim();
            if (text) {
                nodes.set(element.id, { id: element.id, text, kind: 'heading', x: number(element.x), y: number(element.y) });
            }
        }
    }

    // ── ② 找「边」 ────────────────────────────────────────────────────
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const element of list) {
        if (element.isDeleted || element.type !== 'arrow') continue;
        const from = element.startBinding?.elementId;
        const to = element.endBinding?.elementId;
        if (typeof from !== 'string' || typeof to !== 'string') continue;
        if (!nodes.has(from) || !nodes.has(to) || from === to) continue;
        const bucket = children.get(from) ?? [];
        bucket.push(to);
        children.set(from, bucket);
        hasParent.add(to);
    }

    // ── ③ 排成树 ──────────────────────────────────────────────────────
    // 根 = 没有父的块。⚠️ 有环时（用户把箭头连回去了）不能无限走，用 `path` 断环。
    const roots = [...nodes.values()].filter((node) => !hasParent.has(node.id));
    // ⚠️ 全是环（没有根）时**不能输出空** —— 那等于「画布上的东西凭空没了」。
    // 退化成「按位置列一遍」，并且下面会提示这是降级结果。
    const cyclic = roots.length === 0 && nodes.size > 0;
    const order = (ids: string[]) =>
        ids
            .map((id) => nodes.get(id)!)
            .sort((a, b) => a.y - b.y || a.x - b.x);

    const lines: string[] = [];
    const visited = new Set<string>();
    const walk = (node: CanvasNode, depth: number, path: Set<string>) => {
        if (path.has(node.id)) return; // 环：不再往下走
        visited.add(node.id);
        const next = new Set(path).add(node.id);
        // ⚠️★ 正文卡片（段落/代码/表格）输出成**普通段落**，不是标题 ——
        // 它们是内容，不是章节。见 `CanvasNode.kind` 的注释。
        if (node.kind === 'card') {
            lines.push(node.text);
            lines.push('');
            // ⚠️ 卡片的子节点按**同一层**继续（卡片不占一个标题级别）。
            for (const child of order(children.get(node.id) ?? [])) {
                walk(child, depth, next);
            }
            return;
        }
        // ⚠️ 最多 6 层：Markdown 只有 `######`，再深就没有对应的标题级别了。
        // 超出的一律放在第 6 层（与其丢掉，不如压平）。
        lines.push(`${'#'.repeat(Math.min(depth + 1, 6))} ${node.text}`);
        lines.push('');
        for (const child of order(children.get(node.id) ?? [])) {
            walk(child, depth + 1, next);
        }
    };

    const startingPoints = cyclic ? [...nodes.values()].sort((a, b) => a.y - b.y || a.x - b.x) : order(roots.map((r) => r.id));
    for (const root of startingPoints) {
        if (visited.has(root.id)) continue;
        walk(root, 0, new Set());
    }

    // 环里那些**一次都没走到**的块，补在最后 —— 绝不静默丢。
    for (const node of [...nodes.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
        if (!visited.has(node.id)) {
            walk(node, 0, new Set());
        }
    }

    const images = list.filter((element) => !element.isDeleted && element.type === 'image').length;
    if (images > 0) {
        // ⚠️ Markdown 里放不下图片（没有可引用的 URL），但**必须说一句** ——
        // 不说的话用户会以为「导出把图弄丢了」。
        lines.push(`<!-- ${images} 张图片没有导出：Markdown 里放不下画布上的图片 -->`);
        lines.push('');
    }

    const markdown = lines.join('\n').trimEnd();
    // ⚠️ 空画布回空串（而不是一串空行）—— 调用方据此提示「画布上没有可导出的东西」。
    return markdown === '' ? '' : `${markdown}\n`;
}

interface RawElement {
    id?: unknown;
    type?: unknown;
    x?: unknown;
    y?: unknown;
    text?: unknown;
    isDeleted?: unknown;
    customData?: unknown;
    boundElements?: ({ type?: unknown; id?: unknown } | null)[] | null;
    startBinding?: { elementId?: unknown } | null;
    endBinding?: { elementId?: unknown } | null;
}

function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
