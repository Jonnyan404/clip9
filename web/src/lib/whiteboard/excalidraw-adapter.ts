/**
 * 蓝图 → Excalidraw 元素。
 *
 * ⚠️★ 这是**唯一**一处碰 Excalidraw 的地方（除了白板 mode 组件本身）。
 * 布局逻辑全在 `markdown-plan.ts` 里，那边不 import 任何白板引擎 ——
 * 换引擎时只重写这个文件（见那份模块文档的第 2 条理由）。
 *
 * # 为什么用 `convertToExcalidrawElements` 而不是手搓元素对象
 *
 * Excalidraw 的元素 schema 有二十几个字段（`seed` / `versionNonce` / `boundElements` /
 * `roundness` / `frameId` …），而且**随版本演进**。手搓一份等于把这个库的内部形状
 * 抄进我们的代码里 —— 升级时它不会报错，只会画出一堆缺字段的怪东西。
 * `convertToExcalidrawElements` 是这个库**官方给的**「从骨架造元素」入口，默认值归它管。
 */

import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';

import type { PlanNode, WhiteboardPlan } from './markdown-plan';

/**
 * 三档配色。⚠️ 都是 Excalidraw 的**主题无关**取值（它自己会在暗色主题下调整渲染），
 * 所以这里不读我们的 MUI 主题 —— 混两套主题变量会让画布在暗色下出现读不清的深色块。
 */
const PALETTE: Record<PlanNode['kind'], { bg: string; stroke: string }> = {
    // 标题：淡蓝
    heading: { bg: '#e7f5ff', stroke: '#1971c2' },
    // 列表项：白底
    item: { bg: '#ffffff', stroke: '#868e96' },
    // 卡片（段落 / 代码 / 表格）：淡灰
    card: { bg: '#f8f9fa', stroke: '#adb5bd' },
};

/** 卡片上的 `note` 副标题用的字号。 */
const NOTE_FONT_SIZE = 11;
/** 连线的颜色（比任何块都浅，免得抢注意力）。 */
const EDGE_STROKE = '#adb5bd';

/**
 * 蓝图 → Excalidraw 元素。
 *
 * ⚠️ 块的顺序 = **父在子前**：Excalidraw 按数组顺序决定 z 序，
 * 先画父再画子，连线才压在块下面（否则箭头会盖住节点边框）。
 */
export function planToExcalidrawElements(plan: WhiteboardPlan) {
    if (!plan.nodes.length) {
        return [];
    }

    const skeletons: ExcalidrawElementSkeleton[] = [];

    // ── 连线先算，但**排在块的后面 push** —— 见上面那条 z 序说明。 ──
    const edges: ExcalidrawElementSkeleton[] = plan.edges.map(({ from, to }) => ({
        type: 'arrow',
        x: from.x + from.width,
        y: from.y + from.height / 2,
        points: [
            [0, 0],
            [to.x - (from.x + from.width), to.y + to.height / 2 - (from.y + from.height / 2)],
        ],
        strokeColor: EDGE_STROKE,
        strokeWidth: 1,
        // ⚠️ `endArrowhead` 显式给：不给的话某些版本画出来是光秃秃一条线，
        // 而「这是父子关系」正是靠箭头读出来的。
        endArrowhead: 'arrow',
        // 连线不参与「选中后拖动」的成组语义。
        groupIds: [],
    }));

    for (const node of plan.nodes) {
        const palette = PALETTE[node.kind];
        // ⚠️ 字号由蓝图定（标题大、卡片小）—— 这里不再算一遍，
        // 否则「同一个块在布局时按 16px 量、画出来按 14px」会让宽度估算白做。
        const fontSize = node.kind === 'card' ? 14 : node.kind === 'heading' ? 20 : 16;

        skeletons.push({
            type: 'rectangle',
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            backgroundColor: palette.bg,
            strokeColor: palette.stroke,
            fillStyle: 'solid',
            strokeWidth: 1,
            roughness: 1,
            roundness: { type: 3 },
            label: {
                text: node.text,
                fontSize,
                textAlign: 'center',
                verticalAlign: 'middle',
            },
        });

        // `note` 是块外面的小字（代码块的语言、表格的尺寸）——
        // 它必须**在块外**，塞进 label 会把主文案挤变形。
        if (node.note) {
            skeletons.push({
                type: 'text',
                x: node.x + 4,
                y: node.y + node.height + 2,
                text: node.note,
                fontSize: NOTE_FONT_SIZE,
                strokeColor: '#868e96',
            });
        }
    }

    // ⚠️ `regenerateIds: true`：同一次导入里每个块都要有新 id。
    // 不给的话两次导入会产生**撞 id** 的元素，而 Excalidraw 对重复 id 的处理是
    // 「后面那个覆盖前面那个」—— 症状是「导了两次，画布上只剩一份」。
    return convertToExcalidrawElements([...skeletons, ...edges], { regenerateIds: true });
}
