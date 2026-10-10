import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Chip, CircularProgress, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { ConvertRejected, ConvertUnsupported, convertFile, fetchConvertCapability, uploadDocument, type ConvertCapability } from '@/services/convert';
import { markdownToPlan } from '@/lib/whiteboard/markdown-plan';
import { planToExcalidrawElements } from '@/lib/whiteboard/excalidraw-adapter';
import type { ExcalidrawImperativeAPI } from '@/components/whiteboard/ExcalidrawSurface';

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

    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
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
    const dragDepth = useRef(0);
    /** 首帧的元素。⚠️ 只在挂载时读一次 —— 之后画布自己管状态，这里不再回灌。 */
    const initialElements = useRef<readonly never[]>([]);

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
                if (alive) setCapability({ enabled: false, extensions: [] });
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
                // ③ 布局（纯函数，前端这一侧唯一的「智能」）
                const plan = markdownToPlan(converted.markdown);
                if (!plan.nodes.length) {
                    toast(t('canvasNothingToLayOut'));
                    return;
                }
                if (plan.nodes.length > MAX_BLOCKS) {
                    toast(t('canvasTooManyBlocks', { count: plan.nodes.length, max: MAX_BLOCKS }));
                    return;
                }
                // ④ 铺上去。⚠️ **追加**而不是替换：用户可能是「再导一份接在后面」，
                //    替换掉他手上正在画的东西是不可逆的（画布没有撤销栈之外的历史）。
                const existing = apiRef.current?.getSceneElements() ?? [];
                apiRef.current?.updateScene({
                    elements: [...existing, ...planToExcalidrawElements(plan)],
                });
                apiRef.current?.scrollToContent(undefined, { fitToContent: true });
                toast(t('canvasImported', { name: converted.name, count: plan.nodes.length }));
            } catch (error) {
                if (error instanceof ConvertUnsupported) {
                    toast(t('canvasUnsupported'));
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
        [busy, room, t],
    );

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragover(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) void importDocument(file);
    };

    const clearCanvas = () => {
        apiRef.current?.updateScene({ elements: [] });
    };

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
                >
                    {t('canvasImportDoc')}
                </Button>
                <Button
                    size="small"
                    variant="text"
                    startIcon={<MdiIcon name="mdi-fit-to-page-outline" />}
                    onClick={() => apiRef.current?.scrollToContent(undefined, { fitToContent: true })}
                >
                    {t('canvasFit')}
                </Button>
                <Button
                    size="small"
                    variant="text"
                    color="warning"
                    startIcon={<MdiIcon name="mdi-eraser" />}
                    onClick={clearCanvas}
                >
                    {t('canvasClear')}
                </Button>
                {busy && (
                    <Stack direction="row" spacing={1} alignItems="center">
                        <CircularProgress size={14} />
                        <Typography variant="caption">{t('canvasConverting')}</Typography>
                    </Stack>
                )}
                {!busy && supported && (
                    <Typography variant="caption" color="text.secondary">
                        {t('canvasDropHint')}
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
                        theme={theme.palette.mode === 'dark' ? 'dark' : 'light'}
                        // ⚠️ 必须把 locale 传下去：Excalidraw 的界面（工具栏提示、右键菜单、
                        // 快捷键面板）有**完整的**中文译文，但它默认跟 `navigator.language` 走 ——
                        // 不传的话，用户把 clip9 切成中文、浏览器是英文时，白板会中英混排。
                        locale={i18n.language}
                        elements={initialElements.current}
                        onReady={(instance) => {
                            apiRef.current = instance;
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
