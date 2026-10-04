import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Alert, Button, Card, Dialog, DialogContent, DialogTitle, Divider, Stack, Tab, Tabs, Typography,
} from '@mui/material';
import { QRCodeSVG } from 'qrcode.react';
import { buildAppUrl, copyTextToClipboard } from '@/lib/util';
import { toast } from '@/stores/toastStore';
import { MdiIcon } from '@/components/ui/MdiIcon';

// 文件名与 shortcuts/apple/ 下的产物一一对应（由 scripts/sync-shortcuts.mjs 拷进 public）。
// 改捷径文件名时要同步这里。
const APPLE_SHORTCUTS = [
    { file: 'Clip9-Send-Text.shortcut', nameKey: 'scSendText', descKey: 'scSendTextDesc' },
    { file: 'Clip9-Send-File.shortcut', nameKey: 'scSendFile', descKey: 'scSendFileDesc' },
    { file: 'Clip9-Receive.shortcut', nameKey: 'scReceive', descKey: 'scReceiveDesc' },
    { file: 'Clip9-Receive-By-ID.shortcut', nameKey: 'scReceiveById', descKey: 'scReceiveByIdDesc' },
];

// HTTP Shortcuts 是第三方 App（本仓库只提供导入包）。三个官方渠道都在，任选其一。
const ANDROID_APP_LINKS = [
    { icon: 'mdi-google-play', label: 'Google Play', url: 'https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts' },
    { icon: 'mdi-android', label: 'F-Droid', url: 'https://f-droid.org/packages/ch.rmy.android.http_shortcuts/' },
    { icon: 'mdi-github', label: 'GitHub', url: 'https://github.com/Waboodoo/HTTP-Shortcuts/releases' },
];

/** 时间轴每个节点占的宽度（估的、刻意取大：估大了最坏少显示一个日期；估小了那条轴会横向溢出）。 */
const TIMELINE_ITEM_WIDTH = 112;

/**
 * 快捷指令下载 —— 从 web-vue3/src/components/ShortcutsDialog.vue 移植。
 *
 * ⚠️★ 三个地址**不能**用 `config.server.prefix`：prefix 只能从 WS 握手的 `config` 事件拿到，
 * 而本组件的 fetch 在挂载时就跑了 —— 那时 prefix 是空串，`/clip` 部署下会请求成
 * `/shortcuts/meta.json` → 404，还被 catch 吞掉，症状只是「更新日期不见了」。所以用 `buildAppUrl`
 * （相对 `document.baseURI` 推导的应用基准目录，页面加载时就有）。
 *
 * ⚠️ iOS 的二维码必须用 Shortcuts 的**导入 URL 方案**，不能直接放 .shortcut 下载地址 ——
 * 后者扫出来只是「下载了一个文件」，还得自己进「文件」App 找到再点开。
 * `url` 参数要**整体百分号编码**：它自带 `://`，不编码的话其中的 `&` 会把外层查询串拆断。
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<'apple' | 'android'>('apple');
    const [meta, setMeta] = useState<{ apple: string[]; android: string[] }>({ apple: [], android: [] });
    const [qrUrl, setQrUrl] = useState('');
    const [timelineWidth, setTimelineWidth] = useState(0);
    const timelineRef = useRef<HTMLDivElement | null>(null);

    const appleUrl = (file: string) => buildAppUrl(`shortcuts/apple/${file}`);
    const androidUrl = () => buildAppUrl('shortcuts/android/shortcuts.zip');
    const appleImportUrl = (file: string) => `shortcuts://import-shortcut?url=${encodeURIComponent(appleUrl(file))}`;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch(buildAppUrl('shortcuts/meta.json'));
                const data: { apple?: unknown; android?: unknown } = response.ok ? await response.json() : {};
                if (cancelled) return;
                // ⚠️ 用 Array.isArray 把守：早期产物里这两个字段是**字符串**，直接当数组用会当场报错。
                setMeta({
                    apple: Array.isArray(data.apple) ? (data.apple as string[]) : [],
                    android: Array.isArray(data.android) ? (data.android as string[]) : [],
                });
            } catch {
                // 老版本产物里没有这个文件，或者离线 —— 两种都不该影响这个弹窗
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // 时间轴放几个节点**按容器宽度算**：横向排一行，放不下的截掉最旧的（左端用 `+N` 交代）。
    // ⚠️ 这个盒子是懒渲染内容，第一次打开之前它不存在 —— 所以要盯住 ref，它一出现就挂观察器。
    useEffect(() => {
        const el = timelineRef.current;
        if (!open || !el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => setTimelineWidth(entry.contentRect.width));
        observer.observe(el);
        setTimelineWidth(el.clientWidth);
        return () => observer.disconnect();
    }, [open, tab, meta]);

    const history = tab === 'apple' ? meta.apple : meta.android;
    const maxItems = Math.max(1, Math.floor((timelineWidth || 520) / TIMELINE_ITEM_WIDTH));
    // 数据是「最新在前」；轴上从左到右画成「旧 → 新」，所以渲染前反过来。
    const visibleHistory = useMemo(() => history.slice(0, maxItems).reverse(), [history, maxItems]);
    const hiddenCount = Math.max(0, history.length - maxItems);

    const copyLink = async (url: string) => {
        try {
            await copyTextToClipboard(url);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    return (
        <>
            <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <MdiIcon name="mdi-flash" />
                    {t('shortcuts')}
                </DialogTitle>
                <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="fullWidth">
                    <Tab value="apple" label={t('shortcutsApple')} />
                    <Tab value="android" label={t('shortcutsAndroid')} />
                </Tabs>
                <Divider />

                {/* 更新时间轴（内容跟着当前 tab 走）。⚠️ 刻意**不换行** —— 放不下时靠脚本截断，
                    折行会让这条「轴」断成两截，看起来像两组不相干的数据。 */}
                {history.length > 0 && (
                    <Stack sx={{ px: 2, pt: 1.25, pb: 1.5, borderBottom: 1, borderColor: 'divider' }}>
                        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75, color: 'text.secondary' }}>
                            <MdiIcon name="mdi-history" size={16} color="var(--mui-palette-primary-main)" />
                            <Typography variant="caption">{t('scUpdateHistory')}</Typography>
                        </Stack>
                        <Stack ref={timelineRef} direction="row" alignItems="center" sx={{ minWidth: 0 }}>
                            {hiddenCount > 0 && (
                                <Box0>{`+${hiddenCount}`}</Box0>
                            )}
                            {visibleHistory.map((date, index) => (
                                <Stack key={date} direction="row" alignItems="center" spacing={0.75} sx={{ flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
                                    <span
                                        style={{
                                            flex: 'none',
                                            boxSizing: 'border-box',
                                            width: 9,
                                            height: 9,
                                            borderRadius: '50%',
                                            background: index === visibleHistory.length - 1 ? 'var(--mui-palette-primary-main)' : 'color-mix(in srgb, currentColor 24%, transparent)',
                                            boxShadow: index === visibleHistory.length - 1 ? '0 0 0 3px color-mix(in srgb, var(--mui-palette-primary-main) 18%, transparent)' : undefined,
                                        }}
                                    />
                                    <Typography variant="caption">{date}</Typography>
                                    {index !== visibleHistory.length - 1 && (
                                        <span style={{ flex: 'none', width: 12, height: 1, margin: '0 6px', background: 'color-mix(in srgb, currentColor 20%, transparent)' }} />
                                    )}
                                </Stack>
                            ))}
                        </Stack>
                    </Stack>
                )}

                <DialogContent dividers sx={{ maxHeight: '62vh' }}>
                    {tab === 'apple' ? (
                        <>
                            {/* 平台图标先亮出来：这几条捷径 Mac 和 iPhone / iPad 用的是同一份文件。 */}
                            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1.5, color: 'text.secondary', flexWrap: 'wrap' }}>
                                <MdiIcon name="mdi-apple" size={16} />
                                <MdiIcon name="mdi-laptop" size={16} />
                                <MdiIcon name="mdi-cellphone" size={16} />
                                <Typography variant="caption">{t('shortcutsHint')}</Typography>
                            </Stack>

                            <Stack spacing={1.5}>
                                {APPLE_SHORTCUTS.map((sc) => (
                                    <Card key={sc.file} variant="outlined" sx={{ p: 1.5 }}>
                                        <Stack direction="row" alignItems="flex-start" spacing={2}>
                                            <Stack sx={{ flex: 1, minWidth: 0 }}>
                                                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5 }}>
                                                    <MdiIcon name="mdi-apple" size={16} />
                                                    <Typography variant="subtitle2">{t(sc.nameKey)}</Typography>
                                                </Stack>
                                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                                                    {t(sc.descKey)}
                                                </Typography>
                                                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                                                    <Button size="small" variant="contained" startIcon={<MdiIcon name="mdi-download" size={16} />} href={appleUrl(sc.file)} download>
                                                        {t('scDownload')}
                                                    </Button>
                                                    <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-link-variant" size={16} />} onClick={() => copyLink(appleUrl(sc.file))}>
                                                        {t('scCopyLink')}
                                                    </Button>
                                                </Stack>
                                            </Stack>
                                            {/* 二维码直接摊在卡片里：扫码是这条路最主要的用法，藏在弹窗里等于每次多点一下。 */}
                                            <Stack sx={{ flex: 'none', width: 128, boxSizing: 'border-box', p: 0.75, bgcolor: '#fff', borderRadius: 2, alignItems: 'center' }}>
                                                <QRCodeSVG value={appleImportUrl(sc.file)} size={116} level="M" />
                                                <Typography variant="caption" sx={{ mt: 0.5, textAlign: 'center', lineHeight: 1.4, color: 'rgba(0,0,0,0.6)' }}>
                                                    {t('scScanToImport')}
                                                </Typography>
                                            </Stack>
                                        </Stack>
                                    </Card>
                                ))}
                            </Stack>

                            <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>
                                <Typography variant="caption">{t('scAppleSteps')}</Typography>
                            </Alert>
                        </>
                    ) : (
                        <>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                                {t('shortcutsHint')}
                            </Typography>

                            <Card variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
                                <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5 }}>
                                    <MdiIcon name="mdi-android" size={16} />
                                    <Typography variant="subtitle2">{t('scAndroidPackage')}</Typography>
                                </Stack>
                                <Stack direction="row" spacing={0.75} sx={{ mt: 1.5, flexWrap: 'wrap' }}>
                                    <Button size="small" variant="contained" startIcon={<MdiIcon name="mdi-download" size={16} />} href={androidUrl()} download>
                                        {t('scDownload')}
                                    </Button>
                                    <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-link-variant" size={16} />} onClick={() => copyLink(androidUrl())}>
                                        {t('scCopyLink')}
                                    </Button>
                                    <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-qrcode" size={16} />} onClick={() => setQrUrl(androidUrl())}>
                                        {t('scShowQr')}
                                    </Button>
                                </Stack>
                            </Card>

                            <Card variant="outlined" sx={{ p: 1.5 }}>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                                    {t('scAndroidAppHint')}
                                </Typography>
                                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                                    {ANDROID_APP_LINKS.map((link) => (
                                        <Button key={link.url} size="small" variant="text" href={link.url} target="_blank" rel="noopener" startIcon={<MdiIcon name={link.icon} size={16} />}>
                                            {link.label}
                                        </Button>
                                    ))}
                                </Stack>
                            </Card>

                            <Alert severity="info" variant="outlined" sx={{ mt: 1.5 }}>
                                <Typography variant="caption" sx={{ whiteSpace: 'pre-line' }}>{t('scAndroidSteps')}</Typography>
                            </Alert>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            {/* 二维码单独一个小对话框：手机扫码直接下载到设备，比在手机上敲地址省事。 */}
            <Dialog open={Boolean(qrUrl)} onClose={() => setQrUrl('')} maxWidth="xs" fullWidth>
                <DialogContent sx={{ textAlign: 'center', p: 3 }}>
                    <QRCodeSVG value={qrUrl} size={240} level="M" />
                    <Typography variant="caption" sx={{ display: 'block', mt: 1.5 }}>{t('scQrHint')}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}>{qrUrl}</Typography>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** 左端的 `+N`：还有几次更早的更新被截掉了（`+2` 是数字不是文案，不用 i18n）。 */
function Box0({ children }: { children: React.ReactNode }) {
    return (
        <span
            style={{
                flex: 'none',
                marginRight: 10,
                padding: '1px 7px',
                borderRadius: 999,
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
                color: 'color-mix(in srgb, currentColor 60%, transparent)',
                background: 'color-mix(in srgb, currentColor 8%, transparent)',
            }}
        >
            {children}
        </span>
    );
}
