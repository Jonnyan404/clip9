import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, IconButton, Typography } from '@mui/material';
import axios from 'axios';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { MarkdownBody } from '@/components/MarkdownBody';
import { ShareLinkButton } from '@/components/ShareLinkButton';
import { useMarkdown } from '@/hooks/useMarkdown';
import { errorMessage, formatTimestamp, isFileEntry, filePreviewKind, prettyFileSize } from '@/lib/util';
import { downloadFile as saveFileToDisk, fileUrl } from '@/services/file-url';
import { useAppStore, type ReceivedItem } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { useViewerStore } from '@/stores/viewerStore';

/**
 * 全屏查看器 —— 「点开一条，然后一路上下翻」。
 *
 * ⚠️★ 它是**覆盖层，不是第 9 个界面模式**。模式是「整屏换一种排布」，而「点开某一条看全」是
 *    任何模式里都会发生的动作；做成模式的话，标准 / 速览 / 时间线 / 便签里都点不开它，
 *    而为了这一个动作用户还得先切模式 —— 那不是更顺手，是更绕。挂载点在 `AppShell`。
 *
 * ⚠️★ 序列 = **打开那一刻的可见集**（尊重当时的筛选 / 搜索），由调用方传进来。这里**不自己
 *    去 `received` 里筛**：同一份「什么算可见」已经在各模式里算过一次了，再算一遍必然漂
 *    （典型症状：在「只看图片」里翻，翻到一条被筛掉的文字）。
 *
 * ⚠️★ 滚动用**原生 scroll-snap**（`y mandatory` + 每屏 `100dvh` + `snap-align: start`），
 *    不自己算触摸位移：惯性、回弹、快速甩动、触控板双指、滚轮，浏览器都替我们做了；
 *    手写一套 touch 数学在 iOS 上几乎必翻车（尤其是「甩一下应该跳过几条」这种）。
 *    `100dvh` 而不是 `100vh`：移动端地址栏收放时 `vh` 算的是最大值，底部会被切掉一截。
 *
 * ⚠️★ **只挂当前 ±1 的正文**。图片 / 文本都便宜，但一条 100 KB 的 markdown 会跑整条动作链
 *    （异步 + 二次 setState），列表一长就是「打开就卡住」。视频更要紧：一个 4K 视频占的内存
 *    比其余所有条目加起来都多，所以只有邻近的才挂 `<video>`，而且只有当前那条 `preload` 元数据。
 *    因为每屏高度恒定（都是 `100dvh`），惰性挂载**不会**造成布局跳动。
 *
 * ⚠️ 视频**不自动播**：这是剪贴板不是短视频信息流，用户点开一张图时不该被一段声音糊脸。
 *    `playsInline` 是 iOS 上「就地播而不是弹全屏播放器」的唯一开关。
 */
export function MediaViewer() {
    const { t } = useTranslation();
    const ids = useViewerStore((s) => s.ids);
    const initialIndex = useViewerStore((s) => s.initialIndex);
    const close = useViewerStore((s) => s.close);
    const received = useAppStore((s) => s.received);
    const room = useWebSocketStore((s) => s.room);

    const open = ids.length > 0;
    const rootRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [current, setCurrent] = useState(0);
    /**
     * 顶栏里留给「图片工具」的空位（计数与关闭之间）。
     *
     * ⚠️★ 工具条**不浮在图上**：白底图（截图 / 文档照片）一放大，浮层就看不见了，而桌面端
     *    放大后它还会挡住内容。顶栏那一条是**本来就存在**的深色渐变，把按钮放进去等于
     *    不额外占画面。
     * ⚠️ 用**状态**存这个节点而不是 ref：图是深层子组件，首次渲染时这个 Box 还没挂上
     *    （ref 在提交阶段才填），拿到 null 就永远不重渲染、工具条永远不出来。
     */
    const [toolSlot, setToolSlot] = useState<HTMLDivElement | null>(null);

    // id → 条目。⚠️ 渲染时现查，所以被 revoke 的那条会**自然消失**（见 viewerStore 的注释）。
    const items = useMemo(() => {
        const byId = new Map(received.map((item) => [String(item.id), item]));
        return ids.map((id) => byId.get(id)).filter((item): item is ReceivedItem => Boolean(item));
    }, [ids, received]);

    const scrollTo = useCallback((index: number) => {
        const el = scrollRef.current;
        if (!el) return;
        const height = el.clientHeight || window.innerHeight;
        el.scrollTo({ top: index * height, behavior: 'smooth' });
    }, []);

    // 打开那一下：**直接跳**到落点（instant）。用平滑滚动的话，第一屏会从第 0 条一路滑过来 ——
    // 看起来像「我点错了」。
    useLayoutEffect(() => {
        if (!open) return;
        const el = scrollRef.current;
        if (!el) return;
        const height = el.clientHeight || window.innerHeight;
        const at = Math.min(initialIndex, Math.max(0, items.length - 1));
        el.scrollTop = at * height;
        setCurrent(at);
        // ⚠️ 依赖只有 `open`：这是「打开」那一次的定位，不是「每次列表变动都重新定位」。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // 关掉时把「当前」也复位，否则下次打开会先画一帧旧的计数。
    useEffect(() => {
        if (!open) {
            setCurrent(0);
        }
    }, [open]);

    // 序列被清空（最后一条被删 / 整批清空）就自己退出 —— 否则留在**一块纯黑的屏幕**上，
    // 而那看起来像卡死了。
    useEffect(() => {
        if (open && items.length === 0) {
            close();
        }
    }, [open, items.length, close]);

    // 开着时锁住页面滚动（否则背景列表会跟着滚，手指一滑两层都在动）。
    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previous;
        };
    }, [open]);

    // ⚠️★ 打开查看器时把**外面**正在播的媒体停掉（2026-10-26 用户报的「点全屏后两个声音」）：
    // 原地预览里那段视频不会因为我们又开了一层而停下 —— 两路音频同时出声，听着像回声。
    // ⚠️ 只 `pause()`，不 `currentTime = 0` 也不清 `src`：用户关掉查看器还想接着看那一段。
    useEffect(() => {
        if (!open) return;
        for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) {
            if (!rootRef.current?.contains(el)) {
                el.pause();
            }
        }
    }, [open]);

    // 同一个毛病的另一半：**查看器内部**翻到下一条时，上一条的视频要停 ——
    // 否则划走的那条还在后台出声（±1 是挂着的，它不会自己卸载）。
    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        [...scroller.children].forEach((child, index) => {
            if (index === current) return;
            child.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => el.pause());
        });
    }, [current, open]);

    // 键盘：↑↓ 翻，Esc 关。
    // ⚠️ 各模式的列表也有 ↑↓ 导航（速览 / 时间线），它们靠 `isViewerOpen()` 让开 ——
    //    在这里 `stopPropagation` 是没用的（同一个 window 上的监听器照样会跑）。
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
                return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'PageDown' && event.key !== 'PageUp') {
                return;
            }
            event.preventDefault();
            const step = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
            scrollTo(Math.min(Math.max(current + step, 0), Math.max(items.length - 1, 0)));
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [open, current, items.length, close, scrollTo]);

    if (!open) {
        return null;
    }

    return createPortal(
        <Box
            ref={rootRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('preview')}
            // ⚠️ 1200：**低于** MUI 的 Dialog（1300）与 Snackbar（1400）——
            // 查看器开着的时候弹出的确认框 / 提示必须还能盖在它上面。
            sx={{
                position: 'fixed',
                inset: 0,
                zIndex: 1200,
                bgcolor: '#000',
                color: '#fff',
                height: '100dvh',
                overflow: 'hidden',
            }}
        >
            <Box
                ref={scrollRef}
                onScroll={(event: React.UIEvent<HTMLDivElement>) => {
                    const el = event.currentTarget;
                    const height = el.clientHeight || 1;
                    const next = Math.round(el.scrollTop / height);
                    setCurrent((prev) => (prev === next ? prev : next));
                }}
                sx={{
                    height: '100%',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    scrollSnapType: 'y mandatory',
                    scrollbarWidth: 'none',
                    '&::-webkit-scrollbar': { display: 'none' },
                }}
            >
                {items.map((item, index) => {
                    // ⚠️ 惰性挂载：只有邻近的才渲染正文（见文件抬头）。
                    const near = Math.abs(index - current) <= 1;
                    return (
                        <Box
                            key={String(item.id)}
                            onClick={(event: React.MouseEvent<HTMLDivElement>) => {
                                // 只在**点空白处**关（点媒体本身不关 —— 那太容易误触）。
                                if (event.target === event.currentTarget) close();
                            }}
                            sx={{
                                height: '100dvh',
                                scrollSnapAlign: 'start',
                                scrollSnapStop: 'always',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 1.5,
                                px: 2,
                                pt: 7,
                                pb: 9,
                                position: 'relative',
                            }}
                        >
                            {near ? (
                                // ⚠️ 只有**当前**那一条把工具条挂进顶栏：邻近的也挂的话，
                                // 同一个空位里会并排塞进三个工具条。
                                <ViewerBody item={item} room={room} toolSlot={index === current ? toolSlot : null} />
                            ) : null}
                            {near && <ViewerCaption item={item} room={room} />}
                        </Box>
                    );
                })}
            </Box>

            {/* 顶栏：计数 + 关闭。⚠️ 常驻显示，不做「滚动时隐藏」—— 一个全屏覆盖层上
                没有一直可见的关闭入口，用户第一反应是「怎么退出去」。 */}
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.5,
                    py: 1,
                    background: 'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0))',
                    pointerEvents: 'none',
                }}
            >
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.8)', fontVariantNumeric: 'tabular-nums', px: 1 }}>
                    {Math.min(current + 1, items.length)} / {items.length}
                </Typography>
                <Box ref={setToolSlot} sx={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center' }} />
                <IconButton
                    size="small"
                    onClick={close}
                    aria-label={t('close')}
                    sx={{ color: '#fff', pointerEvents: 'auto', bgcolor: 'rgba(255,255,255,0.12)' }}
                >
                    <MdiIcon name="mdi-close" size={20} />
                </IconButton>
            </Box>
        </Box>,
        document.body,
    );
}

/** 一条的正文（媒体 / 文本 / 认不出类型的兜底）。 */
function ViewerBody({ item, room, toolSlot }: { item: ReceivedItem; room: string; toolSlot: HTMLDivElement | null }) {
    const { t } = useTranslation();
    const isFile = isFileEntry(item);
    const kind = isFile ? filePreviewKind(item.name) : '';
    const expired = Boolean(item.expire && Number(item.expire) > 0 && Date.now() / 1000 > Number(item.expire));
    const src = isFile && !expired && kind ? fileUrl(item.cache, { room }) : '';

    if (!isFile) {
        return <ViewerText item={item} />;
    }

    if (expired) {
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, color: 'rgba(255,255,255,0.7)' }}>
                <MdiIcon name="mdi-timer-off" size={48} />
                <Typography variant="body2">{t('expired')}</Typography>
            </Box>
        );
    }

    // 认不出类型的（zip / pdf / 未知扩展名）：**说出来**，而不是给一个空白。
    // 项目原则：失败可以降级，但不能静默。
    if (!kind || !src) {
        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, color: 'rgba(255,255,255,0.7)' }}>
                <MdiIcon name="mdi-file-outline" size={48} />
                <Typography variant="body2">{t('viewerUnsupported')}</Typography>
            </Box>
        );
    }

    if (kind === 'image') {
        return <ZoomableImage src={src} alt={item.name || ''} resetKey={String(item.id)} toolSlot={toolSlot} />;
    }

    if (kind === 'video') {
        return (
            <video
                src={src}
                controls
                playsInline
                preload="metadata"
                style={{ maxWidth: '100%', maxHeight: '100%', display: 'block', background: '#000' }}
            />
        );
    }

    if (kind === 'audio') {
        return (
            <Box sx={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <MdiIcon name="mdi-music-note" size={56} />
                <audio src={src} controls preload="metadata" style={{ width: '100%' }} />
            </Box>
        );
    }

    return <ViewerTextFile item={item} />;
}

/** 放大上限（相对「适应窗口」）。4 倍够看清截图里的小字，再大就只剩马赛克了。 */
const ZOOM_MAX = 4;
/** 按钮 / 键盘一次放大多少倍（1 → 1.5 → 2.25 → 3.375 → 4）。 */
const ZOOM_STEP = 1.5;

/**
 * 旋转后图片的**外接框**（未缩放）：90 / 270 时长宽互换。
 *
 * ⚠️ `offsetWidth` 量的是**没转之前**的排版盒子，CSS transform 不改它 —— 所以夹取边界
 *    必须自己换一次，否则转完再放大，图会被拖到画面外。
 */
function contentSize(img: HTMLImageElement, rot: number) {
    return rot % 180 === 0
        ? { w: img.offsetWidth, h: img.offsetHeight }
        : { w: img.offsetHeight, h: img.offsetWidth };
}

/**
 * 「适应窗口」在当前旋转角下的倍率（乘在 `s` 上）。
 *
 * ⚠️ 旋转 90° 后外接框长宽互换，原来撑满宽度的横图会变成窄窄一条 —— 这个倍率把它
 *    **重新撑满**（iOS 相册旋转就是这个行为）。
 * ⚠️ 第三个上限是 **1:1**：`maxWidth: 100%` 不会把小图拉大，这里也必须跟着不拉大，
 *    否则一张 200×200 的图标会被放大成一团糊。
 */
function fitScale(stage: HTMLElement, img: HTMLImageElement, rot: number) {
    const c = contentSize(img, rot);
    if (!c.w || !c.h || !img.naturalWidth) return 1;
    return Math.min(
        stage.clientWidth / c.w,
        stage.clientHeight / c.h,
        img.naturalWidth / img.offsetWidth,
    );
}

/** 把平移量夹住：放大后的图不该被拖到完全看不见（拖到边上就停住）。 */
function clampView(stage: HTMLElement, img: HTMLImageElement, rot: number, s: number, x: number, y: number) {
    const total = s * fitScale(stage, img, rot);
    const c = contentSize(img, rot);
    const maxX = Math.max(0, (c.w * total - stage.clientWidth) / 2);
    const maxY = Math.max(0, (c.h * total - stage.clientHeight) / 2);
    return { s, x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
}

/**
 * 可缩放 / 可旋转 / 可镜像的一张图（全屏查看器里只给 `image` 用）。
 *
 * 手势按平台分开（2026-10-26 Jonny 的要求：手机上**不要**双击放大，要双指捏合）：
 *
 * | 动作 | 手机（触摸） | 桌面（鼠标） |
 * |---|---|---|
 * | 放大 / 缩小 | **双指捏合**（焦点在两指中点） | 顶栏 `+` / `−`，或键盘 `+` / `-` |
 * | 平移 | 放大后单指拖 | 放大后按住拖 |
 * | 复位（适应窗口 + 摆正 + 不镜像） | 点顶栏的百分比 | 双击，或键盘 `0` |
 * | 实际尺寸 1:1 / 旋转 / 镜像 | 顶栏 | 顶栏 |
 *
 * ⚠️★ **手势没用 React 的 `onTouchMove`**：React 在根节点上注册的 touchmove 是**被动**的，
 *    里面 `preventDefault()` 不生效（还会在控制台警告），于是两指时外层会跟着翻页。
 *    这里自己 `addEventListener('touchmove', …, { passive: false })`。
 *
 * ⚠️★ `touch-action` 必须**随缩放状态切换**（`pan-y` ↔ `none`）：
 *    · 没放大时 `pan-y` —— 单指上下滑仍然是**原生翻页**，查看器的 scroll-snap 全靠它；
 *      改成 `none` 就再也翻不到下一条了（那才是更糟的回归）。
 *    · 放大后 `none` —— 否则浏览器会先把单指拖动当成滚动、再给我们一个 `touchcancel`，
 *      平移永远动不了。
 *
 * ⚠️ 页面在 `index.html` 里禁了 `user-scalable`，所以「浏览器自己也捏合放大一次」不存在，
 *    两指手势完全归这里处理。
 *
 * ⚠️ 换一条时**自动复位**：`resetKey`（条目 id）变了就回到初始状态，不留上一条的旋转。
 */
function ZoomableImage({ src, alt, resetKey, toolSlot }: {
    src: string;
    alt: string;
    resetKey: string;
    /** 顶栏里放工具条的空位；`null` = 这一条不是当前那条，不挂。 */
    toolSlot: HTMLDivElement | null;
}) {
    const { t } = useTranslation();
    const [view, setView] = useState({ s: 1, x: 0, y: 0 });
    /** 旋转角（0 / 90 / 180 / 270）与水平镜像。 */
    const [rot, setRot] = useState(0);
    const [flip, setFlip] = useState(false);
    /**
     * 当前旋转角下的 `fit`，以及「一个原图像素 = 几个屏幕像素」（都在 `s = 1` 时量）。
     *
     * ⚠️ 这两个值要**量**出来（`offsetWidth` / `naturalWidth`），渲染时读 DOM 不可靠 ——
     *    首次渲染 ref 还是 null，而且量出来的结果变了也不会自己触发重渲染。
     */
    const [fit, setFit] = useState(1);
    const [unit, setUnit] = useState(0);
    // ⚠️ 事件回调要读**当前**值，而 `useEffect([])` 的闭包是旧的 —— 用 ref 镜像一份。
    const viewRef = useRef(view);
    viewRef.current = view;
    const rotRef = useRef(rot);
    rotRef.current = rot;

    const stageRef = useRef<HTMLDivElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    /** 捏合起点：两指距离 + 当时的状态 + 两指中点（相对容器中心）。 */
    const pinchRef = useRef<{ dist: number; s: number; x: number; y: number; cx: number; cy: number } | null>(null);
    /** 拖动起点（触摸与鼠标共用一个）。 */
    const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
    /** 最后一次手指离开屏幕的时刻。⚠️ `dblclick` 是 MouseEvent，**拿不到** pointerType，
     *  手机上挡「双击放大」只能靠「刚刚有没有手指」 —— 捏合是主手势，双击是误触。 */
    const lastTouchRef = useRef(0);

    useEffect(() => {
        setView({ s: 1, x: 0, y: 0 });
        setRot(0);
        setFlip(false);
    }, [resetKey]);

    const measure = useCallback(() => {
        const stage = stageRef.current;
        const img = imgRef.current;
        if (!stage || !img || !img.naturalWidth || !img.offsetWidth) return;
        const nextFit = fitScale(stage, img, rotRef.current);
        setFit(nextFit);
        setUnit(nextFit * (img.offsetWidth / img.naturalWidth));
    }, []);

    // ⚠️ 用 layout effect：旋转后先量再画，否则中间会有一帧「用旧的 fit 配新的角度」的跳动。
    useLayoutEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [measure, src, rot]);

    /** `s` 的上限。⚠️ 1:1 必须**总是够得着**（一张 12MP 照片在手机上是 ~10×），所以取
     *  `max(ZOOM_MAX, 1:1 的倍率)` —— 不然「实际尺寸」按了没反应。 */
    const maxScale = () => {
        const stage = stageRef.current;
        const img = imgRef.current;
        if (!stage || !img || !img.offsetWidth || !img.naturalWidth) return ZOOM_MAX;
        return Math.max(ZOOM_MAX, img.naturalWidth / img.offsetWidth / fitScale(stage, img, rotRef.current));
    };

    /** 以 (fx, fy)（容器中心为原点）为焦点缩放到 `nextScale`。 */
    const zoomTo = (nextScale: number, fx = 0, fy = 0) => {
        const stage = stageRef.current;
        const img = imgRef.current;
        if (!stage || !img) return;
        const from = viewRef.current;
        const s = Math.min(maxScale(), Math.max(1, nextScale));
        const k = s / from.s;
        // 焦点下面那一点保持不动：x' = fx - (fx - x) * k
        setView(clampView(stage, img, rotRef.current, s, fx - (fx - from.x) * k, fy - (fy - from.y) * k));
    };

    /** 复位：适应窗口 + 摆正 + 不镜像（一个按钮回到刚打开的样子）。 */
    const reset = () => {
        setView({ s: 1, x: 0, y: 0 });
        setRot(0);
        setFlip(false);
    };

    /** 转 ±90°。⚠️ 转完要**重新夹取**：外接框变了，原来的平移量可能已经出界。 */
    const rotate = (delta: number) => {
        const stage = stageRef.current;
        const img = imgRef.current;
        const next = (rotRef.current + delta + 360) % 360;
        setRot(next);
        if (stage && img) {
            const v = viewRef.current;
            setView(clampView(stage, img, next, v.s, v.x, v.y));
        }
    };

    /** 实际尺寸（1:1：一个原图像素 = 一个屏幕像素）。回到中心，方便逐点看。 */
    const actualSize = () => {
        const stage = stageRef.current;
        const img = imgRef.current;
        if (!stage || !img || !img.offsetWidth || !img.naturalWidth) return;
        const s = img.naturalWidth / img.offsetWidth / fitScale(stage, img, rotRef.current);
        setView(clampView(stage, img, rotRef.current, Math.min(maxScale(), Math.max(1, s)), 0, 0));
    };

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;

        const span = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mid = (a: Touch, b: Touch) => ({
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2,
        });
        /** ⚠️ 按在工具条上**不算**拖图：否则放大后手一抖，`preventDefault()` 会把点击吃掉。 */
        const onToolbar = (event: Event) =>
            Boolean((event.target as Element | null)?.closest?.('[data-zoom-ui]'));

        const onTouchStart = (event: TouchEvent) => {
            if (onToolbar(event)) return;
            if (event.touches.length >= 2) {
                const rect = stage.getBoundingClientRect();
                const m = mid(event.touches[0], event.touches[1]);
                pinchRef.current = {
                    dist: span(event.touches[0], event.touches[1]),
                    s: viewRef.current.s,
                    x: viewRef.current.x,
                    y: viewRef.current.y,
                    cx: m.x - (rect.left + rect.width / 2),
                    cy: m.y - (rect.top + rect.height / 2),
                };
                // 两指按下就接管：不然外层会把这个手势当成滚动
                event.preventDefault();
            } else if (event.touches.length === 1 && viewRef.current.s > 1) {
                dragRef.current = {
                    px: event.touches[0].clientX,
                    py: event.touches[0].clientY,
                    x: viewRef.current.x,
                    y: viewRef.current.y,
                };
            }
        };

        const onTouchMove = (event: TouchEvent) => {
            const img = imgRef.current;
            const rot = rotRef.current;
            if (!img) return;
            if (event.touches.length >= 2 && pinchRef.current) {
                event.preventDefault();
                const p = pinchRef.current;
                const s = Math.min(maxScale(), Math.max(1, p.s * (span(event.touches[0], event.touches[1]) / p.dist)));
                const k = s / p.s;
                setView(clampView(stage, img, rot, s, p.cx - (p.cx - p.x) * k, p.cy - (p.cy - p.y) * k));
                return;
            }
            const d = dragRef.current;
            if (event.touches.length === 1 && d && viewRef.current.s > 1) {
                event.preventDefault();
                setView(clampView(
                    stage, img, rot, viewRef.current.s,
                    d.x + (event.touches[0].clientX - d.px),
                    d.y + (event.touches[0].clientY - d.py),
                ));
            }
        };

        const onTouchEnd = (event: TouchEvent) => {
            if (event.touches.length < 2) pinchRef.current = null;
            if (event.touches.length === 0) {
                dragRef.current = null;
                lastTouchRef.current = Date.now();
            }
        };

        // 鼠标拖动（放大后）。⚠️ 只在 `pointerType === 'mouse'` 时接管：
        // 触摸走上面那三个监听，两条路混在一起会互相清掉对方的起点。
        const onPointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse' || viewRef.current.s <= 1 || onToolbar(event)) return;
            dragRef.current = { px: event.clientX, py: event.clientY, x: viewRef.current.x, y: viewRef.current.y };
        };
        const onPointerMove = (event: PointerEvent) => {
            const img = imgRef.current;
            const d = dragRef.current;
            if (!img || !d || event.pointerType !== 'mouse' || viewRef.current.s <= 1) return;
            setView(clampView(
                stage, img, rotRef.current, viewRef.current.s,
                d.x + (event.clientX - d.px),
                d.y + (event.clientY - d.py),
            ));
        };
        const onPointerUp = () => { dragRef.current = null; };

        // 键盘：`+` / `-` / `0`（桌面端最顺手的三个）。
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                zoomTo(viewRef.current.s * ZOOM_STEP);
            } else if (event.key === '-' || event.key === '_') {
                event.preventDefault();
                zoomTo(viewRef.current.s / ZOOM_STEP);
            } else if (event.key === '0') {
                event.preventDefault();
                reset();
            }
        };

        stage.addEventListener('touchstart', onTouchStart, { passive: false });
        stage.addEventListener('touchmove', onTouchMove, { passive: false });
        stage.addEventListener('touchend', onTouchEnd);
        stage.addEventListener('touchcancel', onTouchEnd);
        stage.addEventListener('pointerdown', onPointerDown);
        stage.addEventListener('pointermove', onPointerMove);
        stage.addEventListener('pointerup', onPointerUp);
        stage.addEventListener('pointercancel', onPointerUp);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            stage.removeEventListener('touchstart', onTouchStart);
            stage.removeEventListener('touchmove', onTouchMove);
            stage.removeEventListener('touchend', onTouchEnd);
            stage.removeEventListener('touchcancel', onTouchEnd);
            stage.removeEventListener('pointerdown', onPointerDown);
            stage.removeEventListener('pointermove', onPointerMove);
            stage.removeEventListener('pointerup', onPointerUp);
            stage.removeEventListener('pointercancel', onPointerUp);
            window.removeEventListener('keydown', onKeyDown);
        };
        // ⚠️ 只挂一次：处理函数全部通过 ref 读最新值，依赖数组里放状态会让监听器每帧重建。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** 屏幕上的一个像素里有多少个原图像素 —— 100% 就是 1:1。 */
    const percent = Math.round(view.s * (unit || 1) * 100);
    const total = view.s * fit;

    return (
        <Box
            ref={stageRef}
            sx={{
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                touchAction: view.s > 1 ? 'none' : 'pan-y',
            }}
        >
            <img
                ref={imgRef}
                src={src}
                alt={alt}
                onLoad={measure}
                onDoubleClick={() => {
                    // ⚠️ 触摸也**会**触发 dblclick（双击），而 Jonny 要的是双指捏合 ——
                    // 手机上别让「手抖点了两下」把图放大。dblclick 上拿不到 pointerType，
                    // 看「500ms 内有没有手指落过」。鼠标保留双击复位 / 放大。
                    if (Date.now() - lastTouchRef.current < 500) return;
                    if (view.s > 1) reset();
                    else zoomTo(2.5);
                }}
                style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    display: 'block',
                    // ⚠️ 顺序不能改：`scaleX(-1)` 在**最右**（先作用），镜像的是图片自己的
                    //    左右，跟着旋转一起转 —— 这才是「把照片翻过来」，不是「屏幕上左右换」。
                    transform: `translate(${view.x}px, ${view.y}px) rotate(${rot}deg) scale(${total}) scaleX(${flip ? -1 : 1})`,
                    transition: dragRef.current || pinchRef.current ? 'none' : 'transform 140ms ease-out',
                    userSelect: 'none',
                    cursor: view.s > 1 ? 'grab' : 'zoom-in',
                }}
                draggable={false}
            />

            {/* 图片工具 —— 渲染到**顶栏**的空位里（`MediaViewer` 的 `toolSlot`，
                就在计数与关闭按钮之间），靠 `createPortal` 送过去。
                ⚠️★ 不浮在图上：白底图（截图 / 文档照片）一放大，浮层就看不见了；桌面端
                    放大之后它还会**挡住内容**。顶栏那条深色渐变本来就常驻，把按钮放进去
                    等于不额外占画面。
                ⚠️ `+` / `−` 是**按钮**不是手势：触屏用户可能只想点一下，而捏合在没有
                    多点触控的设备上用不了。`data-zoom-ui` 是给上面的手势处理看的
                    （按在工具条上**不算**拖图）。
                ⚠️ 顶栏整条是 `pointerEvents: 'none'`，所以药丸要自己打开 `auto`。 */}
            {toolSlot
                ? createPortal(
                    <Box
                        data-zoom-ui
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.25,
                            px: 0.5,
                            py: 0.25,
                            maxWidth: '100%',
                            borderRadius: 20,
                            // ⚠️ 半透明黑 + 模糊是刚需：顶栏渐变在白底图上不够压得住。
                            bgcolor: 'rgba(0,0,0,0.55)',
                            backdropFilter: 'blur(8px)',
                            border: '1px solid rgba(255,255,255,0.16)',
                            pointerEvents: 'auto',
                        }}
                    >
                        <IconButton size="small" aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => zoomTo(view.s / ZOOM_STEP)} sx={zoomButtonSx}>
                            <MdiIcon name="mdi-magnify-minus-outline" size={18} />
                        </IconButton>
                        <Button
                            size="small"
                            aria-label={t('zoomReset')}
                            title={t('zoomReset')}
                            onClick={reset}
                            sx={{
                                ...zoomButtonSx,
                                minWidth: 42,
                                px: 0.5,
                                py: 0.25,
                                fontSize: 11,
                                color: '#fff',
                                fontVariantNumeric: 'tabular-nums',
                                opacity: view.s > 1 || rot !== 0 || flip ? 1 : 0.75,
                            }}
                        >
                            {percent}%
                        </Button>
                        <IconButton size="small" aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => zoomTo(view.s * ZOOM_STEP)} sx={zoomButtonSx}>
                            <MdiIcon name="mdi-magnify-plus-outline" size={18} />
                        </IconButton>

                        <Box sx={{ width: 1, height: 18, mx: 0.25, bgcolor: 'rgba(255,255,255,0.3)' }} />

                        {/* 1:1 —— 截图 / 二维码这类「要看到原始像素」的图，靠按钮一次到位。 */}
                        <IconButton size="small" aria-label={t('zoomActual')} title={t('zoomActual')} onClick={actualSize} sx={zoomButtonSx}>
                            <MdiIcon name="mdi-image-size-select-actual" size={18} />
                        </IconButton>
                        <IconButton size="small" aria-label={t('rotateLeft')} title={t('rotateLeft')} onClick={() => rotate(-90)} sx={zoomButtonSx}>
                            <MdiIcon name="mdi-rotate-left" size={18} />
                        </IconButton>
                        <IconButton size="small" aria-label={t('rotateRight')} title={t('rotateRight')} onClick={() => rotate(90)} sx={zoomButtonSx}>
                            <MdiIcon name="mdi-rotate-right" size={18} />
                        </IconButton>
                        {/* ⚠️ 镜像开着时按钮要**看得出来**，否则连按两次就忘了自己在哪一面。 */}
                        <IconButton
                            size="small"
                            aria-label={t('mirror')}
                            title={t('mirror')}
                            onClick={() => setFlip((prev) => !prev)}
                            sx={{ ...zoomButtonSx, ...(flip ? { bgcolor: 'rgba(255,255,255,0.42)' } : null) }}
                        >
                            <MdiIcon name="mdi-flip-horizontal" size={18} />
                        </IconButton>
                    </Box>,
                    toolSlot,
                )
                : null}
        </Box>
    );
}

/** 药丸里的按钮（`−` / 百分比 / `+` / 1:1 / 旋转 / 镜像共用）。
 *  ⚠️ 底色是透明的：不透明的是**药丸本身**，按钮只负责 hover 时亮一点。 */
const zoomButtonSx = {
    color: '#fff',
    bgcolor: 'transparent',
    p: 0.5,
    '&:hover': { bgcolor: 'rgba(255,255,255,0.18)' },
} as const;

/** 文本**条目**（`type: 'text'`）。 */
function ViewerText({ item }: { item: ReceivedItem }) {
    const content = String(item.content || '');
    const md = useMarkdown(() => content);
    return (
        <Box
            sx={{
                width: '100%',
                maxWidth: 760,
                maxHeight: '100%',
                overflowY: 'auto',
                // ⚠️ 滚到底之后**让外层接管**（默认值就是 auto）：一条长文读完继续上滑
                //    应该翻到下一条，而不是「滑不动了」。
                overscrollBehaviorY: 'auto',
                fontSize: 15,
                lineHeight: 1.8,
                wordBreak: 'break-word',
            }}
        >
            {md.html
                ? <MarkdownBody html={md.html} />
                : <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>}
        </Box>
    );
}

/** 文本**文件**（`.txt` / `.md` / 代码…）：正文要真的去取一次。 */
function ViewerTextFile({ item }: { item: ReceivedItem }) {
    const room = useWebSocketStore((s) => s.room);
    const [text, setText] = useState('');
    const [failed, setFailed] = useState(false);
    const md = useMarkdown(() => text, () => /\.(md|markdown|mdown|mkd)$/i.test(item.name || ''));

    useEffect(() => {
        let cancelled = false;
        setFailed(false);
        // ⚠️ 走 `fileUrl`（带 `?auth=`）而不是 axios：文本文件也可能很大，而这里只需要正文，
        // 不需要进度条 / 取消。失败就**画在页面上**，不弹气泡（气泡在全屏黑底上会被漏看）。
        void fetch(fileUrl(item.cache, { room }))
            .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
            .then((body) => { if (!cancelled) setText(body); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [item.cache, room]);

    if (failed) {
        return <MdiIcon name="mdi-alert-circle-outline" size={48} />;
    }
    if (!text) {
        return <MdiIcon name="mdi-file-document-outline" size={48} />;
    }
    return (
        <Box sx={{ width: '100%', maxWidth: 760, maxHeight: '100%', overflowY: 'auto', overscrollBehaviorY: 'auto' }}>
            {md.html
                ? <MarkdownBody html={md.html} />
                : <pre className="code-block" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>}
        </Box>
    );
}

/** 底栏：文件名 / 大小 / 时间 + 这条的动作。
 *
 * ⚠️★ 动作行是**必须**的，不是装饰：速览模式窄屏原来点一行会开一个带「下载 / 分享 / 删除」的
 *    全屏弹窗，媒体改走查看器之后，那些动作要是没跟过来，用户就没地方删掉一张图了 ——
 *    那是**能力倒退**，而且没有任何提示。
 */
function ViewerCaption({ item, room }: { item: ReceivedItem; room: string }) {
    const { t } = useTranslation();
    const isFile = isFileEntry(item);
    const name = isFile ? String(item.name || '') : '';

    const deleteItem = async () => {
        try {
            await axios.post(`revoke/${item.id}`, null, { params: new URLSearchParams([['room', room]]) });
            toast(t(isFile ? 'deleteSuccessFile' : 'deleteSuccessText', { name: item.name || '' }));
        } catch (error) {
            const msg = errorMessage(error);
            toast(msg ? t('deleteFailedMessageMsg', { msg }) : t('deleteFailedMessage'));
        }
    };

    return (
        <Box
            sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                px: 2,
                py: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                background: 'linear-gradient(0deg, rgba(0,0,0,0.65), rgba(0,0,0,0))',
                // ⚠️ `ShareLinkButton` 只收 `className`，而它在黑底上默认是深灰图标 ——
                // 用后代选择器盖掉（特异性比 `.MuiIconButton-root` 高，能赢）。
                '& .viewer-action': { color: '#fff' },
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                {name && (
                    <Typography variant="caption" noWrap title={name} sx={{ display: 'block', color: 'rgba(255,255,255,0.9)' }}>
                        {name}
                    </Typography>
                )}
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.55)' }}>
                    {[isFile ? prettyFileSize(Number(item.size || 0)) : '', item.timestamp ? formatTimestamp(item.timestamp) : '']
                        .filter(Boolean)
                        .join(' · ')}
                </Typography>
            </Box>
            {isFile && (
                <IconButton size="small" onClick={() => saveFileToDisk(item.cache, item.name, room)} aria-label={t('download')} sx={{ color: '#fff' }}>
                    <MdiIcon name="mdi-download" size={18} />
                </IconButton>
            )}
            <ShareLinkButton meta={item} className="viewer-action" />
            <IconButton size="small" onClick={() => void deleteItem()} aria-label={t('delete')} sx={{ color: '#fff' }}>
                <MdiIcon name="mdi-close-circle-outline" size={18} />
            </IconButton>
        </Box>
    );
}
