import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Collapse,
    IconButton,
    Stack,
    Tooltip,
    Typography,
} from '@mui/material';
import { PageToolbar } from '@/components/AppShell/PageToolbar';
import { CodeBlock } from '@/components/CodeBlock';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { copyTextToClipboard, prettyFileSize } from '@/lib/util';
import {
    ConvertRejected,
    ConvertUnsupported,
    convertFile,
    fetchConvertCapability,
    uploadDocument,
    UploadTooLarge,
    UPLOAD_SAFE_MAX_MIB,
    type ConvertCapability,
} from '@/services/convert';

/**
 * 「转 Markdown」模式 —— 丢文件进来，直接给 Markdown 正文。
 *
 * # 它和白板的区别
 *
 * 白板是**把文档铺成画布**（要布局、要能改）；这个模式**只要文本** ——
 * 拿一份 docx 换一段能贴进任何地方的 Markdown。所以它不做布局、不画图、
 * 也不落盘，纯「进 → 出」。
 *
 * # ⚠️ 它**不是**第二套转换实现
 *
 * 走的是和白板导入**同一条**管线：`uploadDocument` → `POST /convert/{uuid}`。
 * 服务端只有 `anydoc` 那一份解析器，这里只是换个界面把它露出来。
 * 两份实现必然漂 —— 而「同一个文件在白板里和在这里转出来不一样」是最难查的那种 bug。
 *
 * # ⚠️ 能力是**探测**出来的，不是假设的
 *
 * `doc` 是个非默认 feature（anydoc 会拖进几 MB 解析器）。没编的部署要**置灰并说明**，
 * 而不是让用户点了之后收到一句「转换失败」。
 */

/** 一次转换的状态机。⚠️ `failed` 要带**原因**，不能只有一个红点。 */
type ItemState =
    | { phase: 'converting' }
    | { phase: 'done'; markdown: string; chars: number; images: number | null; imagesTruncated: boolean }
    | { phase: 'failed'; reason: string };

interface ConvertItem {
    /** 本地的行 id。⚠️ 不能用文件名 —— 同名文件丢两次会撞。 */
    key: string;
    name: string;
    size: number;
    state: ItemState;
}

export default function ConvertWall() {
    const { t } = useTranslation();
    const room = useWebSocketStore((s) => s.room);

    const [capability, setCapability] = useState<ConvertCapability | null>(null);
    const [items, setItems] = useState<ConvertItem[]>([]);
    const [dragover, setDragover] = useState(false);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    const fileInputRef = useRef<HTMLInputElement>(null);
    /** 拖拽进出会成对触发（进子元素也算一次），所以要计数 —— 只看 `dragleave` 会在划过子元素时闪。 */
    const dragDepth = useRef(0);
    const nextKey = useRef(0);

    const supported = capability?.enabled === true;
    const accept = useMemo(
        () => (capability?.extensions ?? []).map((ext) => `.${ext}`).join(','),
        [capability],
    );

    useEffect(() => {
        let alive = true;
        fetchConvertCapability(room)
            .then((value) => {
                if (alive) setCapability(value);
            })
            .catch(() => {
                if (alive) setCapability({ enabled: false, extensions: [] });
            });
        return () => {
            alive = false;
        };
    }, [room]);

    /**
     * 把一批文件挨个转掉。
     *
     * ⚠️ **串行**，不并发：一份文档的转换要解压 + 解析，并发几份会把内存顶上去
     * （anydoc 会把内嵌资源整个留在内存里），而这里的量级是「人手动丢几个」，
     * 串行的总耗时完全可接受。
     */
    const convertAll = useCallback(
        async (files: File[]) => {
            if (!files.length) return;
            const added: ConvertItem[] = files.map((file) => ({
                key: `f${(nextKey.current += 1)}`,
                name: file.name,
                size: file.size,
                state: { phase: 'converting' },
            }));
            setItems((prev) => [...added, ...prev]);

            for (const [index, file] of files.entries()) {
                const key = added[index].key;
                const settle = (state: ItemState) =>
                    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, state } : item)));
                try {
                    const uploaded = await uploadDocument({ file, room });
                    const converted = await convertFile({ uuid: uploaded.uuid, room });
                    settle({
                        phase: 'done',
                        markdown: converted.markdown,
                        chars: converted.chars,
                        // ⚠️ `null` = **读不出来**（PDF 没有文档模型），不是「没有图」——
                        // 见 `services/convert.ts` 的 `DocumentImages`。界面必须分开说。
                        images: converted.images ? converted.images.items.length : null,
                        imagesTruncated: converted.images?.truncated === true,
                    });
                } catch (error) {
                    settle({ phase: 'failed', reason: reasonOf(error, t) });
                }
            }
        },
        [room, t],
    );

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragover(false);
        if (!supported) {
            toast(t('convertWallUnsupported'));
            return;
        }
        void convertAll([...event.dataTransfer.files]);
    };

    const copyOne = async (markdown: string) => {
        try {
            await copyTextToClipboard(markdown);
            toast(t('convertWallCopied'));
        } catch {
            toast(t('canvasExportFailed'));
        }
    };

    return (
        <Box
            className="convert-wall"
            // ⚠️ 根节点 `100dvh` + 内容区 `flex: 1` —— 与其余模式同一条规矩，
            // 见 `check-display-semantics.mjs` 的判据 7（`flex: 1` ⇒ 祖先要有确定高度）。
            sx={{ display: 'flex', flexDirection: 'column', height: '100dvh', minHeight: 0 }}
            onDragEnter={(event) => {
                event.preventDefault();
                dragDepth.current += 1;
                if (supported) setDragover(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => {
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) setDragover(false);
            }}
            onDrop={onDrop}
        >
            <PageToolbar variant="convert" />

            <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 1, flexWrap: 'wrap', rowGap: 1 }}>
                <Button
                    size="small"
                    variant="outlined"
                    disabled={!supported}
                    startIcon={<MdiIcon name="mdi-file-import-outline" />}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label={t('convertWallPick')}
                >
                    <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{t('convertWallPick')}</Box>
                </Button>
                {items.length > 0 && (
                    <Button
                        size="small"
                        variant="text"
                        color="warning"
                        startIcon={<MdiIcon name="mdi-eraser" />}
                        onClick={() => setItems([])}
                        aria-label={t('convertWallClear')}
                    >
                        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{t('convertWallClear')}</Box>
                    </Button>
                )}
                <Box sx={{ flex: 1 }} />
                {capability && !supported && (
                    <Chip size="small" color="warning" variant="outlined" label={t('canvasUnsupportedShort')} />
                )}
            </Stack>

            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 3 }}>
                {!supported && capability && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                        {t('canvasUnsupported')}
                    </Alert>
                )}

                {items.length === 0 ? (
                    <Box
                        sx={{
                            border: 2,
                            borderStyle: 'dashed',
                            borderColor: dragover ? 'primary.main' : 'divider',
                            borderRadius: 2,
                            py: 8,
                            textAlign: 'center',
                            bgcolor: dragover ? 'action.hover' : 'transparent',
                        }}
                    >
                        <MdiIcon name="mdi-language-markdown-outline" size={40} />
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                            {supported ? t('convertWallDropHint') : t('convertWallNeedFeature')}
                        </Typography>
                    </Box>
                ) : (
                    <Stack spacing={1.5}>
                        {items.map((item) => (
                            <ItemCard
                                key={item.key}
                                item={item}
                                expanded={expanded[item.key] === true}
                                onToggle={() =>
                                    setExpanded((prev) => ({ ...prev, [item.key]: prev[item.key] !== true }))
                                }
                                onCopy={copyOne}
                            />
                        ))}
                    </Stack>
                )}
            </Box>

            <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept={accept}
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    // ⚠️ 清空 value：不清的话「同一个文件连选两次」不触发 change。
                    event.target.value = '';
                    void convertAll(files);
                }}
            />
        </Box>
    );
}

function ItemCard({
    item,
    expanded,
    onToggle,
    onCopy,
}: {
    item: ConvertItem;
    expanded: boolean;
    onToggle: () => void;
    onCopy: (markdown: string) => void;
}) {
    const { t } = useTranslation();
    const done = item.state.phase === 'done' ? item.state : null;

    return (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1 }}>
                {item.state.phase === 'converting' && <CircularProgress size={16} />}
                {done && <MdiIcon name="mdi-check-circle-outline" size={18} />}
                {item.state.phase === 'failed' && <MdiIcon name="mdi-alert-circle-outline" size={18} />}

                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={500} sx={{ wordBreak: 'break-all' }}>
                        {item.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        {prettyFileSize(item.size)}
                        {done && ` · ${t('convertWallChars', { count: done.chars })}`}
                        {/* ⚠️ `null` 是「读不出来」，不许写成「0 张」 —— 那是编造事实。 */}
                        {done && done.images === null && ` · ${t('convertWallImagesUnknown')}`}
                        {done && done.images !== null && done.images > 0 &&
                            ` · ${t(done.imagesTruncated ? 'convertWallImagesPartial' : 'convertWallImages', { count: done.images })}`}
                    </Typography>
                </Box>

                {done && (
                    <>
                        <Tooltip title={t('convertWallCopy')}>
                            <IconButton size="small" onClick={() => onCopy(done.markdown)}>
                                <MdiIcon name="mdi-content-copy" size={18} />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title={t('convertWallExpand')}>
                            <IconButton size="small" onClick={onToggle}>
                                <MdiIcon name={expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'} size={18} />
                            </IconButton>
                        </Tooltip>
                    </>
                )}
            </Stack>

            {item.state.phase === 'failed' && (
                <Alert severity="warning" sx={{ borderRadius: 0 }}>
                    {item.state.reason}
                </Alert>
            )}

            {done && (
                <Collapse in={expanded} unmountOnExit>
                    <Box sx={{ px: 1.5, pb: 1.5 }}>
                        <CodeBlock text={done.markdown} name={`${item.name}.md`} />
                    </Box>
                </Collapse>
            )}
        </Box>
    );
}

/**
 * 把异常翻成一句**人话**。
 *
 * ⚠️ 404 有**两种**来路，修法相反（见 `CanvasWall` 里那段注释）：
 * 服务端真没编 `doc`，或者请求压根没到服务端（dev 代理漏了 `/convert`）。
 * 这里用**能力探测的结果**分 —— 探测说有能力，那 404 就只能是后者。
 */
function reasonOf(error: unknown, t: (key: string, options?: Record<string, unknown>) => string): string {
    if (error instanceof ConvertRejected) return error.reason;
    if (error instanceof ConvertUnsupported) return t('canvasConvertUnreachable');
    if (error instanceof UploadTooLarge) {
        return t('canvasTooLarge', { size: (error.bytes / 1024 / 1024).toFixed(1), limit: UPLOAD_SAFE_MAX_MIB });
    }
    return t('canvasImportFailed');
}
