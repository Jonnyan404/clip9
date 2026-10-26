import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Box, IconButton, Typography } from '@mui/material';
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
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [current, setCurrent] = useState(0);
    /** 放大到 1:1 的那一条（双击切换）。换一条就复位。 */
    const [zoomed, setZoomed] = useState<string | null>(null);

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
        setZoomed(null);
        // ⚠️ 依赖只有 `open`：这是「打开」那一次的定位，不是「每次列表变动都重新定位」。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // 关掉时把「当前」也复位，否则下次打开会先画一帧旧的计数。
    useEffect(() => {
        if (!open) {
            setCurrent(0);
            setZoomed(null);
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
                                <ViewerBody
                                    item={item}
                                    room={room}
                                    zoomed={zoomed === String(item.id)}
                                    onToggleZoom={() => setZoomed((prev) => (prev === String(item.id) ? null : String(item.id)))}
                                />
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
                <Box sx={{ flex: 1 }} />
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
function ViewerBody({ item, room, zoomed, onToggleZoom }: {
    item: ReceivedItem;
    room: string;
    zoomed: boolean;
    onToggleZoom: () => void;
}) {
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
        return (
            <Box
                // 双击放大到 1:1：外层可滚，靠**原生滚动**平移（不写 transform 数学）。
                // ⚠️ 页面禁了 user-scalable（index.html 的 viewport），所以这里不会有
                //    「浏览器自己也放大一次」的冲突。
                onDoubleClick={onToggleZoom}
                sx={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    overflow: zoomed ? 'auto' : 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <img
                    src={src}
                    alt={item.name || ''}
                    style={{
                        maxWidth: zoomed ? 'none' : '100%',
                        maxHeight: zoomed ? 'none' : '100%',
                        objectFit: 'contain',
                        display: 'block',
                    }}
                />
            </Box>
        );
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
