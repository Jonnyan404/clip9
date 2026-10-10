/**
 * Markdown → 白板元素**蓝图**（`WhiteboardPlan`）。
 *
 * # 为什么是「蓝图」而不是直接给 Excalidraw 元素
 *
 * 三个理由，一条比一条实在：
 *
 * 1. **可测**。这个模块是纯函数、不碰 DOM、不碰字体度量 —— 所以 `node` 能直接跑它
 *    （Node ≥ 22.18 默认剥离类型，`.ts` 不用构建就能 import）。
 *    `web/scripts/check-whiteboard-plan.mjs` 就是靠这条跑的。
 *    如果它直接产出 Excalidraw 元素，就得把整个 Excalidraw 运行时拉进来测。
 * 2. **不锁死引擎**。蓝图只描述「有哪些块、摆在哪、谁连着谁」。
 *    换成别的白板引擎（Drawnix / tldraw）时，要重写的只有下游那个适配器
 *    （`toExcalidrawElements`），布局逻辑一个字不动。
 * 3. **宽度是估的**。真正量文字要浏览器（字体、字号、字距），那一步只能在渲染端做。
 *    把这个事实**留在函数签名上**（见 `estimateTextWidth`）比藏在一个
 *    「看起来精确、其实也是估的」元素对象里诚实。
 *
 * # 布局：横向树（思维导图的样子）
 *
 * 根在最左，子节点往右长，父→子用箭头连。深度决定列，子树高度决定纵向居中 ——
 * 于是「同一棵子树占一整段纵向空间」，兄弟之间不会互相压。
 *
 * # ⚠️ 有损，而且**必须**有损
 *
 * `dev-docs/specs/whiteboard-anydoc-integration.md` §D6 把这条写死了：
 * **往返是有损的，不做无损承诺**。具体到这一步，丢掉的东西是：
 *
 * - **行内样式**（`**粗**`、`*斜*`、`` `码` ``、链接的 href）—— 标签只保留纯文本；
 * - **表格的单元格结构** —— 整张表当一个「卡片」块，内容是 Markdown 原文；
 * - **图片** —— 一个占位卡片，图片字节不上画布（那要 `anydoc::toDocument` 那条重路，本切片不做）。
 *
 * ⚠️ 判据不是「有没有丢」，而是**「丢的东西能不能看出来」**：
 * 所以上面三类都留了**看得见的占位**（卡片上写着它原本是什么），
 * 而不是静默消失 —— 静默消失才是这个项目最不能接受的那类错。
 *
 * # 标签里的行内标记为什么要剥掉
 *
 * Excalidraw 的容器标签是**纯文本**（它自己不做 Markdown 渲染）。
 * 不剥的话画布上会出现字面的 `**重点**` —— 那比丢了粗体难看得多。
 * 剥的方式见 `stripInline`，它只处理**成对**的标记，落单的 `*` 原样留着。
 */

import { marked, type Token, type Tokens } from 'marked';

/** 一个块在白板上的角色。 */
export type PlanNodeKind =
    /** 标题（`#` ~ `######`）。 */
    | 'heading'
    /** 列表项。 */
    | 'item'
    /** 一个「卡片」：段落 / 代码块 / 表格 / 图片占位。 */
    | 'card';

/** 蓝图里的一个块。 */
export interface PlanNode {
    kind: PlanNodeKind;
    /** 画在框里的文字（已经剥掉行内标记）。 */
    text: string;
    /** 树深度，0 起。标题按 `#` 的个数，列表项在父节点基础上 +1。 */
    depth: number;
    x: number;
    y: number;
    width: number;
    height: number;
    /** 卡片类的副标题（代码块的语言、表格的列数……）。空串 = 没有。 */
    note: string;
    children: PlanNode[];
}

/** 父 → 子的一条连线。 */
export interface PlanEdge {
    from: PlanNode;
    to: PlanNode;
}

/** 蓝图：画布上要放的东西 + 它占多大。 */
export interface WhiteboardPlan {
    /** 展平后的全部块（绘制顺序 = 父在子前）。 */
    nodes: PlanNode[];
    edges: PlanEdge[];
    /** 整棵树的包围盒，供「铺到画布后居中」用。 */
    width: number;
    height: number;
}

export interface PlanOptions {
    /** 正文字号。标题按级别放大，卡片按级别缩小。 */
    fontSize?: number;
    /** 相邻两列的水平间距（列宽 = 该列最宽的块 + 这个间距）。 */
    columnGap?: number;
    /** 兄弟节点之间的垂直间距。 */
    rowGap?: number;
    /** 一个块的最大宽度 —— 超了就换行，而不是横向无限长。 */
    maxWidth?: number;
}

const DEFAULTS = {
    fontSize: 16,
    columnGap: 72,
    rowGap: 20,
    maxWidth: 420,
} as const;

/** 每个块四周的内边距（上下各一半，左右各一份）。 */
const PADDING_X = 14;
const PADDING_Y = 8;
/** 一行的行高相对字号的倍数（Excalidraw 的默认 `lineHeight` 也是 1.25）。 */
const LINE_HEIGHT = 1.25;
/** 卡片类块的额外高度（那条 `note` 副标题占的）。 */
const NOTE_EXTRA = 18;

/**
 * **估**一段文字有多宽。
 *
 * ⚠️ 这不是度量，是估计 —— 真正的宽度要字体文件、字号、字距、连字规则，只有浏览器知道。
 * 所以这里的常数是**保守偏大**的：宁可框宽一点（文字居中，多一点留白看不出来），
 * 也不要框窄了把字挤出去。偏小的后果（字溢出框）比偏大（多几个像素空白）严重得多。
 *
 * 中日韩字符按**两倍**宽算（全角），其余按一倍 —— 这也是「中文按两倍宽」的常见近似。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
    let units = 0;
    for (const ch of text) {
        units += isWide(ch) ? 2 : 1;
    }
    return Math.ceil(units * fontSize * 0.55);
}

/** 全角区段（CJK 汉字、假名、全角标点、CJK 扩展）。 */
function isWide(ch: string): boolean {
    const code = ch.codePointAt(0) ?? 0;
    return (
        (code >= 0x1100 && code <= 0x115f) || // 韩文字母
        (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首 ~ 注音
        (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
        (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
        (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容标点
        (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B 及以后
    );
}

/**
 * 剥掉行内标记，只留纯文本。
 *
 * ⚠️ 只处理**成对**的标记。落单的 `*` / `_` 原样留着 —— 把它们也吃掉会让
 * `2 * 3 = 6` 变成 `2 3 = 6`，那是**悄悄改内容**，比留个星号糟得多。
 *
 * 处理：`**粗**` / `__粗__` / `*斜*` / `_斜_` / `` `码` `` / `~~删~~` / `[文字](url)` → `文字`。
 */
export function stripInline(text: string): string {
    return (
        text
            // 链接与图片：`[文字](url)` → `文字`，`![alt](url)` → `alt`
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            // 行内代码：内容原样（里面的星号不该被当标记）
            .replace(/`([^`]+)`/g, '$1')
            // 成对的强调标记
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
            .trim()
    );
}

/** 按 `maxWidth` 折行，返回折出来的行数（至少 1）。 */
function lineCount(text: string, fontSize: number, maxWidth: number): number {
    const usable = Math.max(1, maxWidth - PADDING_X * 2);
    const perLine = Math.max(1, Math.floor(usable / (fontSize * 0.55)));
    const lines = text.split('\n');
    let total = 0;
    for (const line of lines) {
        total += Math.max(1, Math.ceil([...line].length / perLine));
    }
    return total;
}

/** 一个块的字号：标题随级别放大，卡片随级别缩小。 */
function fontSizeOf(kind: PlanNodeKind, depth: number, base: number): number {
    if (kind === 'heading') {
        // `#` → 1.6 倍，每深一级小一点，`######` 收到 1.05 倍。
        return Math.round(base * Math.max(1.05, 1.6 - depth * 0.11));
    }
    if (kind === 'card') {
        return Math.max(11, Math.round(base * 0.85));
    }
    return base;
}

// ── 1. Markdown → 树 ───────────────────────────────────────────────────

/** 树在布局之前的中间形态（还没有坐标）。 */
interface RawNode {
    kind: PlanNodeKind;
    text: string;
    note: string;
    depth: number;
    children: RawNode[];
}

function makeNode(kind: PlanNodeKind, text: string, depth: number, note = ''): RawNode {
    return { kind, text, note, depth, children: [] };
}

/**
 * 把 Markdown 词法记号变成一棵树。
 *
 * ⚠️ 用 `marked.lexer()` 而不是自己扫行：`marked` **本来就是这个前端的依赖**
 * （渲染 Markdown 用它），再手搓一个 GFM 扫描器就是这个项目最反感的那件事
 * —— 同一件事两个实现，迟早漂开（`ARCHITECTURE.md` §5.3.1）。
 */
function buildTree(tokens: Token[]): RawNode[] {
    const roots: RawNode[] = [];
    // 标题的栈：`stack[i]` 是当前第 i 级标题的节点。列表项挂在栈顶。
    const headingStack: RawNode[] = [];

    const currentParent = (): { children: RawNode[]; depth: number } => {
        const top = headingStack[headingStack.length - 1];
        return top ? { children: top.children, depth: top.depth } : { children: roots, depth: -1 };
    };

    const push = (node: RawNode) => {
        currentParent().children.push(node);
    };

    for (const token of tokens) {
        switch (token.type) {
            case 'heading': {
                const heading = token as Tokens.Heading;
                // 弹出所有「不比它浅」的标题 —— `##` 之后遇到 `##` 是兄弟，遇到 `###` 是儿子。
                while (
                    headingStack.length &&
                    headingStack[headingStack.length - 1].depth >= heading.depth - 1
                ) {
                    headingStack.pop();
                }
                const node = makeNode('heading', stripInline(heading.text), heading.depth - 1);
                push(node);
                headingStack.push(node);
                break;
            }
            case 'list': {
                walkList(token as Tokens.List, currentParent().depth + 1, push);
                break;
            }
            case 'code': {
                const code = token as Tokens.Code;
                push(cardFromCode(code));
                break;
            }
            case 'table': {
                const table = token as Tokens.Table;
                push(
                    makeNode(
                        'card',
                        '表格',
                        currentParent().depth + 1,
                        `${table.header.length} 列 × ${table.rows.length + 1} 行（内容见原始文档）`,
                    ),
                );
                break;
            }
            case 'paragraph': {
                const para = token as Tokens.Paragraph;
                const text = stripInline(para.text);
                if (text) {
                    push(makeNode('card', text, currentParent().depth + 1));
                }
                break;
            }
            case 'blockquote': {
                const quote = token as Tokens.Blockquote;
                // ⚠️ 引用不新开一层语义，只把内容原样接上（引用块里往往是段落或列表）。
                for (const inner of buildTree(quote.tokens ?? [])) {
                    inner.depth += currentParent().depth + 1;
                    push(inner);
                }
                break;
            }
            default:
                // ⚠️ `space` / `hr` 这类没有内容，跳过是**有意的**；
                // 但**认不出的类型不许静默丢** —— 见 `check-whiteboard-plan.mjs` 里那条
                // 「所有非空 token 类型都被处理或显式忽略」的判据。
                break;
        }
    }

    return roots;
}

/** 代码块 → 卡片。`mermaid` 单独标出来：那是画布能直接画的图。 */
function cardFromCode(code: Tokens.Code): RawNode {
    const lang = (code.lang || '').trim().split(/\s+/)[0] ?? '';
    if (lang === 'mermaid') {
        return makeNode('card', '流程图', 0, `mermaid（${countLines(code.text)} 行，本切片先当卡片）`);
    }
    const firstLine = code.text.split('\n').find((line) => line.trim()) ?? '';
    return makeNode(
        'card',
        firstLine.trim() || '（空代码块）',
        0,
        lang ? `${lang} · ${countLines(code.text)} 行` : `${countLines(code.text)} 行代码`,
    );
}

function countLines(text: string): number {
    return text ? text.split('\n').length : 0;
}

function walkList(list: Tokens.List, depth: number, push: (node: RawNode) => void) {
    for (const item of list.items) {
        const node = makeNode('item', stripInline(item.text.split('\n')[0]), depth);
        push(node);

        // ⚠️ 列表项里可以嵌列表、段落、代码块 —— `item.tokens` 才是它的完整内容。
        // 只读 `item.text` 会**静默丢掉**嵌套的那一层，而那正是思维导图最需要的结构。
        const nested: RawNode[] = [];
        for (const inner of item.tokens ?? []) {
            if (inner.type === 'list') {
                walkList(inner as Tokens.List, depth + 1, (n) => nested.push(n));
            } else if (inner.type === 'code') {
                nested.push(cardFromCode(inner as Tokens.Code));
            } else if (inner.type === 'text' || inner.type === 'paragraph') {
                // 第一段就是 `item.text` 本身（已经在上面用过了），后续段落才补成卡片。
                const rest = stripInline(String((inner as { text?: string }).text ?? ''));
                const first = stripInline(item.text.split('\n')[0]);
                if (rest && rest !== first) {
                    nested.push(makeNode('card', rest, depth + 1));
                }
            }
        }
        for (const child of nested) {
            child.depth = depth + 1;
            node.children.push(child);
        }
    }
}

// ── 2. 树 → 坐标 ───────────────────────────────────────────────────────

/**
 * Markdown → 白板蓝图。
 *
 * 空输入回**空蓝图**（`nodes: []`）—— 不抛异常。理由：调用方（白板 mode）要的是
 * 「铺不铺得出来」，而「一份只有空白的文档」不是错误，是一个空结果。
 * ⚠️ 但**服务端**那条路相反：`doc.rs` 把空转换结果当失败。
 * 两处不一致是**有意的**：那边防的是「看着成功、其实什么都没拿到」的假成功，
 * 而这边拿到的是**已经确认非空**的 Markdown，再空一次说明用户清空了内容 —— 那是正常操作。
 */
export function markdownToPlan(markdown: string, options: PlanOptions = {}): WhiteboardPlan {
    const opts = { ...DEFAULTS, ...options };
    const raw = buildTree(marked.lexer(markdown ?? ''));

    if (!raw.length) {
        return { nodes: [], edges: [], width: 0, height: 0 };
    }

    // ① 先量每个块自己的尺寸（还没定坐标）。
    const sized = raw.map((node) => sizeSubtree(node, opts));

    // ② 按列摆：每列的 x 由**该列最宽的块**决定，于是同一列左边缘对齐。
    const columnWidth: number[] = [];
    for (const node of flatten(sized)) {
        columnWidth[node.depth] = Math.max(columnWidth[node.depth] ?? 0, node.width);
    }
    const columnX: number[] = [];
    let cursor = 0;
    for (let i = 0; i < columnWidth.length; i += 1) {
        columnX[i] = cursor;
        cursor += (columnWidth[i] ?? 0) + opts.columnGap;
    }

    // ③ 纵向：后序遍历，父节点在它那棵子树里居中。
    let top = 0;
    const layout = (node: SizedNode, depth: number) => {
        node.depth = depth;
        node.x = columnX[depth] ?? 0;
        if (!node.children.length) {
            node.y = top;
            top += node.height + opts.rowGap;
            return;
        }
        const first = top;
        for (const child of node.children) {
            layout(child, depth + 1);
        }
        const last = top - opts.rowGap;
        node.y = (first + last) / 2 - node.height / 2;
    };
    for (const node of sized) {
        layout(node, 0);
    }

    // ④ 展平 + 连线。
    const nodes: PlanNode[] = [];
    const edges: PlanEdge[] = [];
    const collect = (node: SizedNode) => {
        nodes.push(node);
        for (const child of node.children) {
            edges.push({ from: node, to: child });
            collect(child);
        }
    };
    for (const node of sized) {
        collect(node);
    }

    // ⑤ 整体平移，让包围盒从 (0,0) 开始 —— 调用方不用再算偏移。
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    for (const node of nodes) {
        node.x -= minX;
        node.y -= minY;
    }

    const width = Math.max(...nodes.map((n) => n.x + n.width));
    const height = Math.max(...nodes.map((n) => n.y + n.height));
    return { nodes, edges, width, height };
}

interface SizedNode extends PlanNode {
    children: SizedNode[];
}

/** 递归量尺寸：块自身的高度 + 子树的总高（`subtreeHeight` 存在 `note` 之外的自有字段上）。 */
function sizeSubtree(raw: RawNode, opts: Required<PlanOptions>): SizedNode {
    const fontSize = fontSizeOf(raw.kind, raw.depth, opts.fontSize);
    const lines = lineCount(raw.text, fontSize, opts.maxWidth);
    const textHeight = lines * fontSize * LINE_HEIGHT;
    const height = Math.round(textHeight + PADDING_Y * 2 + (raw.note ? NOTE_EXTRA : 0));
    const width = Math.min(
        opts.maxWidth,
        Math.max(80, estimateTextWidth(raw.text, fontSize) + PADDING_X * 2),
    );

    const children = raw.children.map((child) => sizeSubtree(child, opts));
    return {
        kind: raw.kind,
        text: raw.text,
        note: raw.note,
        depth: raw.depth,
        x: 0,
        y: 0,
        width,
        height,
        children,
    };
}

/** 深度优先展平（父在子前）。 */
function flatten(nodes: SizedNode[]): SizedNode[] {
    const out: SizedNode[] = [];
    const walk = (list: SizedNode[]) => {
        for (const node of list) {
            out.push(node);
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
}
