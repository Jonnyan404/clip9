import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    Stack,
    Tooltip,
    Typography,
    useTheme,
} from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { copyTextToClipboard, isFileEntry } from '@/lib/util';
import { ConvertRejected, ConvertUnsupported, convertFile, convertUnsupportedKey, fetchConvertCapability, uploadDocument, UploadTooLarge, UPLOAD_SAFE_MAX_MIB, type ConvertCapability } from '@/services/convert';
import { markdownToPlan } from '@/lib/whiteboard/markdown-plan';
import { applyScene, planToExcalidrawElements, type CanvasImage } from '@/lib/whiteboard/excalidraw-adapter';
import { isWhiteboardName, parseWhiteboard, serializeWhiteboard, whiteboardFileName } from '@/lib/whiteboard/document';
import { DRAFT_MAX_BYTES, clearDraft, readDraft, writeDraft } from '@/lib/whiteboard/draft';
import { elementsToMarkdown } from '@/lib/whiteboard/to-markdown';
import type { ExcalidrawImperativeAPI } from '@/components/whiteboard/ExcalidrawSurface';

/**
 * 在浏览器里量一张图片的**原始像素尺寸**。
 *
 * ⚠️ 为什么不放在 `excalidraw-adapter` 里：解码是异步的、要 `new Image()`（DOM），
 * 而那个模块**必须能在纯 node 里跑**（`check-whiteboard-plan.mjs` 靠这条）。
 * 所以「量尺寸」留在这儿，「排位置」留在那儿 —— 那条边界同时也是「布局是纯函数」的保证。
 *
 * ⚠️ 量不出来时回 `null`，**不抛**：一张图坏掉不该让整份文档导不进来。
 * 调用方跳过它，并把跳过的张数如实报给用户（见 `importDocument` 的提示语）。
 */
async function decodeImageSize(dataUrl: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve(null);
        image.src = dataUrl;
    });
}

/**
 * 白板模式 —— `dev-docs/specs/whiteboard-anydoc-integration.md` 的 P1 切片。
 *
 * # 它是什么
 *
 * 一块无限画布（Excalidraw），加上「**文档进画布**」这条主链路：
 *
 * ```text
 * 用户拖入一份 docx
 *   → POST /upload            变成 clip9 的一条文件条目（留溯源）
 *   → POST /convert/<uuid>    anydoc 转成 Markdown（服务端那份唯一的实现）
 *   → markdownToPlan()        纯函数：Markdown → 蓝图（结构 + 坐标）
 *   → planToExcalidrawElements()  蓝图 → 画布元素
 *   → api.updateScene()       铺上去
 * ```
 *
 * # ⚠️ 为什么前端不自己解析文档
 *
 * 文档解析（docx / pdf / xlsx…）**只有服务端那一份实现**，就是 `clip9-actions` 的
 * `doc.rs`（`anydoc`）。前端**不许**另写一份 —— 那是 `ARCHITECTURE.md` §5.3.1 记着的坑：
 * 两个实现必然漂，症状是「同一个文件在两条路上转出不同结果」。
 * 前端负责的是**布局**（`markdown-plan.ts`），那是服务端不该管的事
 * （它不知道画布多大、用户想看什么形状）。
 *
 * # ⚠️ 跨框架那一整层不存在了
 *
 * 方案稿 §1.3 / §10 花了大篇幅讨论「React 白板怎么嵌进 Vue3 宿主」（island / Web Component /
 * iframe 三条路）。**2026-10-04 前端整体切到 React 之后，这一层整个消失了** ——
 * 白板就是第 6 个 mode，与另外五个平级，没有桥接、没有协议、没有第二套运行时。
 *
 * # 本切片**不做**的事（写在界面上，不假装支持）
 *
 * - **不落盘**：白板内容目前只在内存里（刷新就没了）。要变成 clip9 的文件条目
 *   （方案 §2.4）是下一个切片 —— 那一步做完，分享 / 过期 / 多设备同步才跟着免费到手。
 * - **不导出**：白板 → docx 是 P2（方案 §4.4，要另起 `pulldown-cmark` + `docx-rs` 那条线）。
 * - **图片不上画布**：`anydoc` 默认把图片降级成 alt 文本；要图片也上板得走
 *   `toDocument` 那条重路（保留嵌入资源原始字节），本切片没做。
 */

/** Excalidraw 单独一个 chunk —— 见 `ExcalidrawSurface` 的模块文档。 */
const ExcalidrawSurface = lazy(() => import('@/components/whiteboard/ExcalidrawSurface'));

/**
 * 窄屏（手机）上按钮**只留图标**。
 *
 * ⚠️★ 这 5 个按钮带文字时在手机上会**换行成两行**，吃掉约 100px —— 而 iPhone 13
 * 的视口一共才 664px，也就是**约 15% 的屏幕**给了一排按钮（2026-10-11 实测）。
 * 图标本身认得出来（导入 / 适应 / 清空 / 保存 / 打开），所以窄屏去掉文字、宽屏照旧。
 *
 * ⚠️ 去掉文字**必须**补 `aria-label`（下面每个按钮都给了）—— 否则读屏软件只会念出
 * 一个没有名字的按钮。
 */
const BUTTON_LABEL_SX = { display: { xs: 'none', sm: 'inline' } } as const;

/**
 * 只有触屏、没有鼠标的设备。
 *
 * ⚠️ 用它来决定**文案**，不用它来决定**功能** —— 带触摸屏的笔记本
 * （`pointer: coarse` 为假但能触屏）两者都有，按「有没有鼠标」分功能会分错。
 * ⚠️ 与 `StickyComposer` 用的是同一条判据，改的时候一起改。
 */
const isTouchOnly =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : false;

/** 一份文档最多铺多少个块 —— 超了先拦住，而不是让画布卡死。 */
const MAX_BLOCKS = 400;

/**
 * 「这台部署没有文档转换能力」那条提示被关掉了吗。
 *
 * ⚠️★ 存 localStorage 而不是组件 state：这条提示说的是**部署的固有属性**（构建时有没有带
 * `doc` feature），它不会自己变。只用组件 state 的话，每次切进白板 mode 都会再弹一次 ——
 * 那就从「告知」变成「骚扰」了，而用户关掉它的动作会被反复作废。
 * ⚠️ 与 `pageToolbarCollapsed` / `darkmode` 那几条同一个规矩（都是 localStorage 里的界面偏好）。
 */
const CONVERT_NOTICE_KEY = 'canvasConvertNoticeDismissed';

export default function CanvasWall() {
    // ⚠️ 取 `i18n` 而不是直接 import 单例：设置里切语言走的是 `changeLanguage`，
    // **不 reload 页面**。用单例读 `.language` 只在挂载那一刻是对的，
    // 之后切语言白板的界面不会跟着变（而别的模式会）—— 那种不一致最难查。
    const { t, i18n } = useTranslation();
    const theme = useTheme();
    const room = useWebSocketStore((s) => s.room);
    /** 房间里的条目 —— 用来找「已经存在的白板」（见下面的 `boards`）。 */
    const received = useAppStore((s) => s.received);

    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    /** 草稿写入的防抖句柄（`onChange` 一秒能来几十次，见 `onSceneChange`）。 */
    const draftTimer = useRef<number | null>(null);
    /** 「草稿存不下」只提示一次，别每次画布变化都弹。 */
    const draftWarned = useRef(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [capability, setCapability] = useState<ConvertCapability | null>(null);
    const [busy, setBusy] = useState(false);
    const [dragover, setDragover] = useState(false);
    const [noticeDismissed, setNoticeDismissed] = useState(
        () => localStorage.getItem(CONVERT_NOTICE_KEY) === '1',
    );
    const dismissNotice = useCallback(() => {
        localStorage.setItem(CONVERT_NOTICE_KEY, '1');
        setNoticeDismissed(true);
    }, []);

    /**
     * 这个房间里**已有的白板** —— 就是「名字以 `.excalidraw` 结尾的文件条目」。
     *
     * ⚠️ 用 `isFileEntry` 而不是 `type === 'file'`：那个字段有**两种来源**
     * （WS 事件给入库类型、历史接口给 MIME 派生类型），直接比 `'file'` 会把
     * 刷新前后的行为弄成两样。理由写在 `appStore.ts` 的 `ReceivedItem.type` 上。
     */
    const boards = useMemo(
        () =>
            received
                .filter((item) => isFileEntry(item) && isWhiteboardName(item.name))
                .map((item) => ({ uuid: String(item.cache ?? ''), name: String(item.name ?? '') }))
                .filter((item) => item.uuid),
        [received],
    );
    const [boardMenuAnchor, setBoardMenuAnchor] = useState<HTMLElement | null>(null);
    const dragDepth = useRef(0);
    /**
     * 首帧的内容 = **本地草稿**（如果有）。
     *
     * ⚠️ 按房间读（`draft.ts` 的模块文档解释了为什么不能共用一个键），
     * 而且画布上挂了 `key={room}` —— 换房间会**重新挂载**画布，
     * 于是首帧数据跟着换。不重挂的话 `initialData` 只在第一次生效，
     * 换了房间画布还是上一个房间的内容。
     */
    const draft = useMemo(() => {
        const raw = readDraft(room);
        return raw ? parseWhiteboard(raw) : null;
    }, [room]);
    // 能力探测：这台部署到底带不带转换（`doc` feature）。⚠️ 判据只有服务端那一处。
    useEffect(() => {
        let alive = true;
        fetchConvertCapability(room)
            .then((value) => {
                if (alive) setCapability(value);
            })
            .catch(() => {
                // 探测失败（老服务端 / 网络）→ 当成「没有这个能力」，不弹错。
                // 猜成「有」的后果是界面上出现一个点进去必然失败的入口。
                if (alive) setCapability({ enabled: false, extensions: [], reason: null });
            });
        return () => {
            alive = false;
        };
    }, [room]);

    const importDocument = useCallback(
        async (file: File) => {
            if (busy) return;
            if (!file.size) {
                toast(t('canvasEmptyFile'));
                return;
            }
            setBusy(true);
            try {
                // ① 先上传 —— 转换挂在文件条目上，而条目也是**溯源**的落点
                //    （铺出来的块将来要带 `clip9FileId` 指回这份文档）。
                const uploaded = await uploadDocument({ file, room });
                // ② 服务端转 Markdown
                const converted = await convertFile({ uuid: uploaded.uuid, room });
                // ③ 图片：服务端把内嵌图片的字节一起带回来了（Markdown 里没有它们，
                //    见 `doc.rs` 的注释 —— 上游转 Markdown 时会把图片整段丢掉）。
                //    ⚠️ `converted.images === null` 是「这个格式读不出来」（PDF），
                //    **不是**「没有图」—— 两者在提示语里必须分开说。
                const images: CanvasImage[] = [];
                let skipped = 0;
                for (const item of converted.images?.items ?? []) {
                    const dataUrl = `data:${item.mime};base64,${item.data}`;
                    const size = await decodeImageSize(dataUrl);
                    if (size) {
                        images.push({ dataUrl, mime: item.mime, ...size });
                    } else {
                        skipped += 1;
                    }
                }

                // ④ 布局（纯函数，前端这一侧唯一的「智能」）
                const plan = markdownToPlan(converted.markdown);
                if (!plan.nodes.length && !images.length) {
                    toast(t('canvasNothingToLayOut'));
                    return;
                }
                const total = plan.nodes.length + images.length;
                if (total > MAX_BLOCKS) {
                    toast(t('canvasTooManyBlocks', { count: total, max: MAX_BLOCKS }));
                    return;
                }

                // ⑤ 铺上去。⚠️ **追加**而不是替换：用户可能是「再导一份接在后面」，
                //    替换掉他手上正在画的东西是不可逆的（画布没有撤销栈之外的历史）。
                const scene = planToExcalidrawElements(plan, {
                    images,
                    imageGroupLabel: images.length
                        ? t('canvasImageGroup', { count: images.length })
                        : '',
                });
                applyScene(apiRef.current!, scene, apiRef.current?.getSceneElements() ?? []);
                apiRef.current?.scrollToContent(undefined, { fitToContent: true });

                // ⑥ 如实报出「铺了多少、图有没有缺」——**这是这一整条链路里唯一的诚实出口**。
                const found = converted.images?.total ?? 0;
                const missing = found - images.length;
                if (converted.images === null) {
                    // PDF：读不出文档模型，**不知道**有没有图。不许编造一个数字。
                    toast(t('canvasImportedUnknownImages', { name: converted.name, count: plan.nodes.length }));
                } else if (missing > 0 || skipped > 0) {
                    toast(
                        t('canvasImportedWithMissing', {
                            name: converted.name,
                            count: plan.nodes.length,
                            found,
                            placed: images.length,
                        }),
                    );
                } else if (images.length) {
                    toast(
                        t('canvasImportedWithImages', {
                            name: converted.name,
                            count: plan.nodes.length,
                            images: images.length,
                        }),
                    );
                } else {
                    toast(t('canvasImported', { name: converted.name, count: plan.nodes.length }));
                    // ⚠️★ 多栏 PDF 的文字是**左右交错**的，而铺成树之后**更像正常文档**了 ——
                    // 必须单独说一句，否则用户以为导对了。见 `services/convert.ts` 的 `PdfLayout`。
                    const columns = converted.pdf?.multiColumnPages.length ?? 0;
                    if (columns > 0) {
                        toast(t('pdfMultiColumn', { count: columns }));
                    }
                }
            } catch (error) {
                if (error instanceof ConvertUnsupported) {
                    // ⚠️★ 404 有**两种**来路，而它们的修法完全相反：
                    //
                    // 1. 服务端真没编 `doc`（路由没注册）；
                    // 2. **请求没打到服务端** —— dev 下 vite 的代理漏了 `/convert` 时，
                    //    vite 的 SPA 兜底会回一个**没有 body 的 404**。
                    //
                    // 只看状态码分不开（都是 404、都没 JSON），所以用**能力探测的结果**分：
                    // 服务端刚说过它有这个能力，那 404 就只可能是第 2 种。
                    // 2026-10-10 实测踩到：服务端 `--all-features`、`convert.enabled: true`，
                    // 而 dev 下导入报的是「这台服务端没有编译文档转换能力」——
                    // **把人往「重编服务端」上带，而真正缺的是 vite 配置里一行代理。**
                    toast(capability?.enabled ? t('canvasConvertUnreachable') : t(convertUnsupportedKey(capability?.reason ?? null)));
                } else if (error instanceof ConvertRejected) {
                    // ⚠️ 直接用服务端那句中文 —— 它是唯一知道「为什么转不了」的地方。
                    toast(error.reason);
                } else {
                    toast(t('canvasImportFailed'));
                }
            } finally {
                setBusy(false);
            }
        },
        [busy, capability, room, t],
    );

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragover(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) void importDocument(file);
    };

    /**
     * 把画布导出成 Markdown 大纲（复制到剪贴板）。
     *
     * ⚠️ 层级**靠连线的绑定**还原，不靠坐标 —— 见 `to-markdown.ts` 的模块文档。
     * ⚠️ 它是**有损**的（手绘、图片收不进去），而 `to-markdown.ts` 会在结果里
     * 留一句注释说明丢了几张图；这里只管把结果交出去，不额外美化。
     */
    const exportMarkdown = useCallback(async () => {
        const elements = apiRef.current?.getSceneElements() ?? [];
        const markdown = elementsToMarkdown(elements);
        if (!markdown) {
            toast(t('canvasNothingToExport'));
            return;
        }
        // ⚠️ `copyTextToClipboard` 失败时**抛**（不是回 false）——
        // 它内部有 `execCommand` 的降级路径，两条都失败才抛。
        try {
            await copyTextToClipboard(markdown);
            toast(t('canvasExported', { lines: markdown.trimEnd().split('\n').length }));
        } catch {
            toast(t('canvasExportFailed'));
        }
    }, [t]);

    const clearCanvas = () => {
        apiRef.current?.updateScene({ elements: [] });
        // ⚠️★ 草稿**必须一起清**：不清的话刷新会把用户刚删掉的东西**恢复回来**，
        // 而那是「删了又自己回来」——比「删不掉」更让人不敢相信这个界面。
        clearDraft(room);
    };

    /**
     * 画布变了 → 存本地草稿（**防抖**）。
     *
     * ⚠️★ Excalidraw 的 `onChange` 在拖动时一秒能调几十次，直接在里面序列化 + 写盘
     * 会让拖动一顿一顿的。防抖 800 ms 之后才真写。
     *
     * ⚠️ 空画布**清掉**草稿而不是存一份空的 —— 存空的会让下次刷新「恢复」出一张空画布，
     * 还把上一份真草稿覆盖掉。
     */
    const onSceneChange = useCallback(
        (elements: readonly unknown[], files: Record<string, unknown>) => {
            if (draftTimer.current !== null) {
                window.clearTimeout(draftTimer.current);
            }
            draftTimer.current = window.setTimeout(() => {
                draftTimer.current = null;
                const live = (elements as { isDeleted?: boolean }[]).filter((el) => !el.isDeleted);
                if (!live.length) {
                    clearDraft(room);
                    return;
                }
                const result = writeDraft(room, serializeWhiteboard(live, files));
                // ⚠️★ 存不下时**必须把旧草稿也清掉**（2026-10-10 补）。
                //
                // 不清的话会留下**上一份**草稿：用户往画布上加了一大堆东西 →
                // 这份太大存不下 → 旧的那份还在 → 刷新后他拿到一张
                // **看起来正常、其实是更旧的**画布，而且**没有任何迹象**。
                // 那比一张空画布危险得多：空画布他会去查，一份像模像样的旧画布
                // 他会直接在上面接着画，然后把旧状态当成当前状态。
                //
                // 空画布 + 一句「草稿已停用」是**响亮**的，而旧状态是**沉默**的。
                // 项目原则（方案 §6.5）是「绝不静默丢」—— 那就选响亮的那种。
                if (result !== 'ok') {
                    clearDraft(room);
                    // 只提示一次：每次画布变化都弹会把界面刷屏，
                    // 而这件事的解法只有一个（去点「保存到房间」），说一遍就够。
                    if (!draftWarned.current) {
                        draftWarned.current = true;
                        toast(
                            t(result === 'too-big' ? 'canvasDraftTooBig' : 'canvasDraftUnavailable', {
                                limit: DRAFT_MAX_BYTES / 1024 / 1024,
                            }),
                        );
                    }
                }
            }, 800);
        },
        [room, t],
    );

    // ⚠️ 挂载（或换房间）时如果恢复出了内容，说一句 —— 用户刚刷新完，
    // 「东西还在」这件事必须**看得见**，否则他会以为又丢了。
    useEffect(() => {
        if (draft?.elements?.length) {
            toast(t('canvasDraftRestored', { count: draft.elements.length }));
        }
    }, [draft, t]);

    /**
     * 把画布存成房间里的**一条文件条目**（方案 §2.4）。
     *
     * ⚠️ 服务端**没有「更新一个文件」的接口**，所以这是**新建一条**，不是覆盖。
     * 同一个白板存三次就是三张卡片 —— 本切片的已知取舍，写在
     * `lib/whiteboard/document.ts` 的模块文档里。
     *
     * ⚠️ `getSceneElements()` 给的是**活的**元素（含 `isDeleted` 的墓碑），
     * 直接序列化会把删掉的东西也存进去，别人打开时看不到但文件白白变大。
     */
    const saveToRoom = useCallback(async () => {
        const elements = (apiRef.current?.getSceneElements() ?? []).filter((el) => !el.isDeleted);
        if (!elements.length) {
            toast(t('canvasNothingToSave'));
            return;
        }
        setBusy(true);
        try {
            const name = whiteboardFileName(t('canvasFileName'));
            // ⚠️ MIME 给一个明确的值（不是默认的空串）：它进的是 multipart 的那一段，
            // 而服务端 `determine_response_type` 是按**文件名**判类型的，不冲突。
            const file = new File([serializeWhiteboard(elements, apiRef.current?.getFiles() ?? {})], name, {
                type: 'application/vnd.excalidraw+json',
            });
            await uploadDocument({ file, room });
            toast(t('canvasSaved', { name }));
        } catch (error) {
            if (error instanceof UploadTooLarge) {
                toast(
                    t('canvasTooLarge', {
                        size: (error.bytes / 1024 / 1024).toFixed(1),
                        limit: UPLOAD_SAFE_MAX_MIB,
                    }),
                );
            } else {
                toast(t('canvasSaveFailed'));
            }
        } finally {
            setBusy(false);
        }
    }, [room, t]);

    /**
     * 从房间里打开一份白板。
     *
     * ⚠️ `responseType: 'text'`：服务端发的是 `application/vnd.excalidraw+json`，
     * axios 不会自动解析它 —— 不指定的话拿到的是**已经被 axios 猜过一遍**的东西，
     * 而猜错时的表现是「加载失败」而不是「解析失败」，排查会走弯路。
     */
    const openBoard = useCallback(
        async (uuid: string, name: string) => {
            setBoardMenuAnchor(null);
            setBusy(true);
            try {
                const response = await axios.get(`file/${uuid}`, {
                    params: new URLSearchParams([['room', room]]),
                    responseType: 'text',
                });
                const parsed = parseWhiteboard(String(response.data ?? ''));
                if (!parsed) {
                    toast(t('canvasNotABoard', { name }));
                    return;
                }
                // ⚠️★ **先补图片资源，再放元素**（顺序反了图片会画成占位框，而且不会自己补上）。
                // 这些 `fileId → {dataURL}` 就存在白板 JSON 的 `files` 里 ——
                // 保存时没带上它的话，这里能补的也是空的。
                const files = Object.values(parsed.files);
                if (files.length) {
                    apiRef.current?.addFiles(files as never);
                }
                apiRef.current?.updateScene({ elements: parsed.elements as never });
                apiRef.current?.scrollToContent(undefined, { fitToContent: true });
                toast(t('canvasOpened', { name }));
            } catch {
                toast(t('canvasOpenFailed'));
            } finally {
                setBusy(false);
            }
        },
        [room, t],
    );

    const supported = capability?.enabled === true;
    const accept = capability?.extensions?.length
        ? capability.extensions.map((ext) => `.${ext}`).join(',')
        : undefined;

    return (
        <Box
            className="canvas-wall"
            // ⚠️★ `100dvh` 而**不是** `100%`：外壳**不给**模式组件一个确定的高度
            // （它是普通块级流，不是定高 flex 容器），所以 `height: '100dvh'` 会退化成
            // `auto` = 内容高度 —— 下面那个 `flex: 1` 的画布区随之塌成 **1px**。
            // 症状极其隐蔽：**没有报错、没有警告**，画布元素在 DOM 里、`<canvas>` 也在，
            // 只是 Excalidraw 量到的高度是 0，于是一片空白（看起来像「还没加载完」）。
            // 另外五个模式的根节点都是 `100dvh`，这条是跟着它们来的。
            // ⚠️ `dvh` 而不是 `vh`：移动端地址栏收起/展开时 `vh` 会算错，底部被切掉一截。
            sx={{ display: 'flex', flexDirection: 'column', height: '100dvh', minHeight: 0 }}
            onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                if (supported) setDragover(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => {
                // ⚠️ 深度计数：拖过子元素也会触发 `dragleave`，直接关掉会闪。
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) setDragover(false);
            }}
            onDrop={onDrop}
        >
            <PageToolbar variant="canvas" />

            <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ px: 1.5, py: 1, flexWrap: 'wrap', rowGap: 1 }}
            >
                <Button
                    size="small"
                    variant="outlined"
                    disabled={!supported || busy}
                    startIcon={<MdiIcon name="mdi-file-import-outline" />}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={t('canvasImportDoc')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasImportDoc')}</Box>
                </Button>
                <Button
                    size="small"
                    variant="text"
                    startIcon={<MdiIcon name="mdi-fit-to-page-outline" />}
                    onClick={() => apiRef.current?.scrollToContent(undefined, { fitToContent: true })}
                    aria-label={t('canvasFit')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasFit')}</Box>
                </Button>
                <Button
                    size="small"
                    variant="text"
                    color="warning"
                    startIcon={<MdiIcon name="mdi-eraser" />}
                    onClick={clearCanvas}
                    aria-label={t('canvasClear')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasClear')}</Box>
                </Button>
                <Button
                    size="small"
                    variant="text"
                    startIcon={<MdiIcon name="mdi-language-markdown-outline" />}
                    onClick={() => void exportMarkdown()}
                    aria-label={t('canvasExport')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasExport')}</Box>
                </Button>
                <Button
                    size="small"
                    variant="outlined"
                    disabled={busy}
                    startIcon={<MdiIcon name="mdi-content-save-outline" />}
                    onClick={() => void saveToRoom()}
                    aria-label={t('canvasSave')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasSave')}</Box>
                </Button>
                <Button
                    size="small"
                    variant="text"
                    // ⚠️ 没有白板时**不禁用**，而是点开一个写着「这个房间还没有白板」的菜单。
                    // 禁用的按钮不解释自己为什么是灰的，用户只会以为功能坏了。
                    startIcon={<MdiIcon name="mdi-folder-open-outline" />}
                    onClick={(event) => setBoardMenuAnchor(event.currentTarget)}
                    aria-label={t('canvasOpen')}
                >
                    <Box component="span" sx={BUTTON_LABEL_SX}>{t('canvasOpen')}</Box>
                </Button>
                {busy && (
                    <Stack direction="row" spacing={1} alignItems="center">
                        <CircularProgress size={14} />
                        <Typography variant="caption">{t('canvasConverting')}</Typography>
                    </Stack>
                )}
                {!busy && supported && (
                    <Typography variant="caption" color="text.secondary">
                        {t(isTouchOnly ? 'canvasDropHintTouch' : 'canvasDropHint')}
                    </Typography>
                )}
                {/*
                  ⚠️★ 「这台部署没有转换能力」**不再是一整行的 Alert**（2026-10-10 改）。
                  原来那个 Alert 独占一行，手机上本来就不够高，还被它吃掉一条 ——
                  而这条信息**只在第一次进白板时有用**。

                  改成：工具栏行里的一个小芯片（紧跟在置灰的「导入文档」旁边，
                  读起来正好是「那个按钮为什么是灰的」），**完整解释在悬停提示里**，
                  右边那个 × 关掉之后**永久记住**（localStorage）。
                */}
                {capability && !supported && !noticeDismissed && (
                    <Tooltip title={t('canvasUnsupported')}>
                        <Chip
                            size="small"
                            variant="outlined"
                            color="info"
                            icon={<MdiIcon name="mdi-information-outline" />}
                            label={t('canvasUnsupportedShort')}
                            onDelete={dismissNotice}
                        />
                    </Tooltip>
                )}
            </Stack>

            <input
                ref={fileInputRef}
                type="file"
                hidden
                accept={accept}
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    // ⚠️ 清空 value：不清的话「同一个文件连选两次」不会触发 change。
                    event.target.value = '';
                    if (file) void importDocument(file);
                }}
            />

            {/*
              房间里已有的白板。⚠️ 列表来自**房间条目**（`received`），不是另开一个接口 ——
              白板就是文件条目，它已经在房间的消息流里了。
              ⚠️ 只看得到**当前这一屏历史**里的白板：更早的会被 `server.history` 截掉。
              要「所有白板」得走 `GET /content` 分页，那是另一个切片。
            */}
            <Menu
                anchorEl={boardMenuAnchor}
                open={Boolean(boardMenuAnchor)}
                onClose={() => setBoardMenuAnchor(null)}
            >
                {boards.length === 0 && (
                    <MenuItem disabled>{t('canvasNoBoards')}</MenuItem>
                )}
                {boards.map((board) => (
                    <MenuItem key={board.uuid} onClick={() => void openBoard(board.uuid, board.name)}>
                        <ListItemIcon>
                            <MdiIcon name="mdi-draw" />
                        </ListItemIcon>
                        <ListItemText>{board.name}</ListItemText>
                    </MenuItem>
                ))}
            </Menu>

            <Box
                sx={{
                    position: 'relative',
                    flex: 1,
                    minHeight: 0,
                    borderTop: 1,
                    borderColor: 'divider',
                    // ⚠️ 拖拽高亮用 outline 而不是 border：border 会改布局（画布尺寸跟着跳），
                    // 而 Excalidraw 是按容器尺寸初始化画布的 —— 尺寸一变就白重排一次。
                    outline: dragover ? '2px dashed' : 'none',
                    outlineColor: 'primary.main',
                    outlineOffset: -4,
                }}
            >
                <Suspense
                    fallback={
                        <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
                            <CircularProgress size={28} />
                        </Stack>
                    }
                >
                    <ExcalidrawSurface
                        // ⚠️ 换房间要重挂画布（否则 `initialData` 还是上一个房间的草稿）。
                        key={room}
                        theme={theme.palette.mode === 'dark' ? 'dark' : 'light'}
                        // ⚠️ 必须把 locale 传下去：Excalidraw 的界面（工具栏提示、右键菜单、
                        // 快捷键面板）有**完整的**中文译文，但它默认跟 `navigator.language` 走 ——
                        // 不传的话，用户把 clip9 切成中文、浏览器是英文时，白板会中英混排。
                        locale={i18n.language}
                        elements={(draft?.elements ?? []) as never}
                        files={draft?.files ?? {}}
                        onChange={onSceneChange}
                        onReady={(instance) => {
                            apiRef.current = instance;
                            // ⚠️★ 从草稿恢复时**必须**做一次「适应内容」：
                            // `initialData` 里的元素是按它们**原来的坐标**画的，
                            // 而画布刚挂载时视口在原点 —— 于是恢复出来的东西贴在左上角，
                            // 一多半压在工具栏底下（实测过，看起来像「恢复了一半」）。
                            //
                            // ⚠️★ 两个坑，都实测踩过：
                            // 1. `scrollToContent(undefined, …)` 在这里**等于没调** ——
                            //    `onReady` 那一刻场景里还没有元素，它对一个空场景做「适应」，
                            //    结果是 100% 缩放、视口不动。
                            // 2. 元素**必须显式传**，而且要等一帧（`requestAnimationFrame`）：
                            //    回调返回时 Excalidraw 才刚拿到 `initialData` 开始渲染。
                            if (draft?.elements?.length) {
                                const elements = draft.elements;
                                requestAnimationFrame(() => {
                                    apiRef.current?.scrollToContent(elements as never, {
                                        fitToContent: true,
                                    });
                                });
                            }
                        }}
                    />
                </Suspense>

                {dragover && (
                    <Box
                        sx={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            bgcolor: 'action.hover',
                            pointerEvents: 'none',
                        }}
                    >
                        <Typography variant="h6">{t('canvasDropToImport')}</Typography>
                    </Box>
                )}
            </Box>
        </Box>
    );
}
