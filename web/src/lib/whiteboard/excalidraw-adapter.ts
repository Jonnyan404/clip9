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
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

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

/** 文档里的图片铺在画布上的最大边长（等比缩放到这个框里）。 */
const IMAGE_MAX_SIDE = 240;
/** 图片之间的间距，以及图片区与上面那棵树之间的间距。 */
const IMAGE_GAP = 24;

/**
 * 一张要画到画布上的图片。
 *
 * ⚠️ `width` / `height` 是**原始像素尺寸**，由调用方在浏览器里解码得到
 * （`new Image()` 的 `naturalWidth`）—— 这里不自己解，因为解码是异步的、
 * 要 DOM，而这个模块必须能在纯 node 里跑（`check-whiteboard-plan.mjs` 靠这条）。
 */
export interface CanvasImage {
    /** `data:<mime>;base64,...` —— Excalidraw 的 `files` 里存的就是它。 */
    dataUrl: string;
    mime: string;
    width: number;
    height: number;
}

export interface ExcalidrawScene {
    elements: readonly ReturnType<typeof convertToExcalidrawElements>[number][];
    /** 要给 `api.addFiles()` 的资源。⚠️ 不先加它们，图片元素会画成一个占位框。 */
    files: BinaryFileData[];
}

/**
 * 蓝图（+ 图片）→ Excalidraw 元素。
 *
 * ⚠️ 块的顺序 = **父在子前**：Excalidraw 按数组顺序决定 z 序，
 * 先画父再画子，连线才压在块下面（否则箭头会盖住节点边框）。
 *
 * # 图片为什么铺在**下面**而不是插在文中的位置
 *
 * `anydoc` 转 Markdown 时会把内嵌图片**整段丢掉**（实测连 `![alt]` 都没有），
 * 所以 Markdown 里**没有位置信息**可用 —— 图片只能作为一组单独铺上去。
 *
 * ⚠️ 这个取舍是**声明过的**，不是偷懒：方案 §D6 写着「文档→白板：结构保真，
 * **样式/精确排版不保真**」。而画布本来就是给人重排的地方 ——
 * 用户看到那组图，拖到想要的位置就是了。反过来（为了位置去重写整个映射器、
 * 让它吃文档模型）是另一件事，见方案 §D6 的「下一步」。
 *
 * ⚠️ 图上**必须**有一句说明（`imageGroupLabel`）：不给的话用户会以为
 * 「文档里的图没导进来」，而实际上它们都在下面等着被拖。
 */
export function planToExcalidrawElements(
    plan: WhiteboardPlan,
    options: { images?: CanvasImage[]; imageGroupLabel?: string } = {},
): ExcalidrawScene {
    const images = options.images ?? [];
    if (!plan.nodes.length && !images.length) {
        return { elements: [], files: [] };
    }

    const skeletons: ExcalidrawElementSkeleton[] = [];
    const files: BinaryFileData[] = [];

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

    if (images.length) {
        skeletons.push(...imageSkeletons(plan, images, options.imageGroupLabel ?? '', files));
    }

    // ⚠️ `regenerateIds: true`：同一次导入里每个块都要有新 id。
    // 不给的话两次导入会产生**撞 id** 的元素，而 Excalidraw 对重复 id 的处理是
    // 「后面那个覆盖前面那个」—— 症状是「导了两次，画布上只剩一份」。
    return {
        elements: convertToExcalidrawElements([...skeletons, ...edges], { regenerateIds: true }),
        files,
    };
}

/**
 * 把图片排成一行（超宽就换行），摆在整棵树的下方。
 *
 * ⚠️ 返回的是 **skeleton**，但 `files` 是**当场塞进传入的那个数组**的 ——
 * 因为 `convertToExcalidrawElements` 只认 skeleton，而 `addFiles` 要的是
 * 另一套 `BinaryFileData`。两边**必须用同一个 fileId**，所以在这里一起造。
 */
function imageSkeletons(
    plan: WhiteboardPlan,
    images: CanvasImage[],
    label: string,
    files: BinaryFileData[],
): ExcalidrawElementSkeleton[] {
    const out: ExcalidrawElementSkeleton[] = [];
    const top = plan.height + IMAGE_GAP * 2;

    if (label) {
        out.push({
            type: 'text',
            x: 0,
            y: top - IMAGE_GAP,
            text: label,
            fontSize: 16,
            strokeColor: '#495057',
        });
    }

    let x = 0;
    let rowHeight = 0;
    let y = top;
    for (const image of images) {
        // 等比缩放到 IMAGE_MAX_SIDE 的框里。⚠️ 不按原始像素画：
        // 一张 4000×3000 的手机照片会把画布撑成一片空白（Excalidraw 会把视口缩到极远）。
        const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        if (x > 0 && x + width > IMAGE_MAX_SIDE * 4) {
            // 一行最多放四张，超了换行 —— 否则 20 张图会排成一条看不到头的线。
            y += rowHeight + IMAGE_GAP;
            x = 0;
            rowHeight = 0;
        }

        const fileId = `clip9-img-${files.length}` as BinaryFileData['id'];
        files.push({
            id: fileId,
            mimeType: image.mime as BinaryFileData['mimeType'],
            dataURL: image.dataUrl as BinaryFileData['dataURL'],
            created: Date.now(),
        });
        out.push({
            type: 'image',
            x,
            y,
            width,
            height,
            fileId,
            // ⚠️ `status` 必须给 `saved`：不给的话 Excalidraw 认为这张图还在上传中，
            // 会画成一个**带警告三角的占位框** —— 而图片其实已经在 `files` 里了。
            status: 'saved',
        });

        x += width + IMAGE_GAP;
        rowHeight = Math.max(rowHeight, height);
    }

    return out;
}

/**
 * 把图片资源交给画布。
 *
 * ⚠️★ **必须**先 `addFiles` 再 `updateScene`。反过来的话图片元素引用的 `fileId`
 * 在画布上还不存在，Excalidraw 会画一个占位框，而且**之后不会自己补上** ——
 * 症状是「图导进来了，但显示成一堆问号框」。
 *
 * ⚠️ 单独抽出来是为了让调用方一眼看见这个顺序要求（`CanvasWall` 那两处导入都用它）。
 */
export function applyScene(api: ExcalidrawImperativeAPI, scene: ExcalidrawScene, existing: readonly unknown[]) {
    if (scene.files.length) {
        api.addFiles(scene.files);
    }
    api.updateScene({
        elements: [...(existing as never[]), ...(scene.elements as never[])],
    });
}
