import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { QRCodeSVG } from 'qrcode.react';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import {
    SHARE_DEFAULT_TTL_MINUTES, SHARE_MAX_TTL_MINUTES, SHARE_MAX_USES_LIMIT, SHARE_MIN_TTL_MINUTES,
    buildCleanAbsoluteRouteUrl, copyTextToClipboard, formatShareDuration, formatTimestamp,
    minutesToShareTTL, normalizeShareMaxUses, normalizeShareTTL, withCurrentOrigin, withShareQrFlag,
} from '@/lib/util';
import { SHARE_TTL_PRESET_MINUTES, shareTtlProgress } from '@/lib/share-config.js';
import { createShareLink } from '@/services/share';
import { MdiIcon } from '@/components/ui/MdiIcon';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 分享：一个图标，一个面板 —— 从 web-vue3/src/components/ShareLinkButton.vue 移植。
 *
 * ⚠️ 「复制链接」与「二维码」产出的**是同一个 URL**（分享页地址），所以合成一条路径：
 * 点图标 →（可选：有效期/次数/密码设置框）→ 链接进剪贴板 + 弹出面板。
 * ⚠️ 两种形态：`iconOnly`（卡片图标，受 `display.cardShare` 管）/ 带文字（详情弹窗动作行，
 * **不受开关管** —— 那个开关叫「卡片图标」，只管卡片上那排图标）。
 */
export function ShareLinkButton({
    meta,
    iconOnly = true,
    className,
}: {
    meta: ReceivedItem;
    iconOnly?: boolean;
    className?: string;
}) {
    const { t } = useTranslation();
    const cardShare = useAppStore((s) => s.displayByMode[s.uiMode]?.cardShare ?? true);
    const shareDialogEnabled = useAppStore((s) => s.displayByMode[s.uiMode]?.shareDialog ?? true);
    const shareDefaults = useAppStore((s) => s.shareDefaults);
    const prefix = useAppStore((s) => s.config?.server?.prefix || '');
    const room = useWebSocketStore((s) => s.room);

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [resultOpen, setResultOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [shareUrl, setShareUrl] = useState('');
    const [form, setForm] = useState({ ttlMinutes: SHARE_DEFAULT_TTL_MINUTES, maxUses: 0, password: '' });

    // 兜底地址：服务端一律签发 token 并回分享页地址，只有在拿不到 url 时才用这条。
    const fallbackUrl = buildCleanAbsoluteRouteUrl(
        `content/${meta?.id ?? ''}${room ? `?room=${encodeURIComponent(room)}` : ''}`,
        prefix,
    );
    // 二维码里编的地址要比「复制到剪贴板的那条」多一个 q=1（扫码进来要能上报）。
    const qrUrl = withShareQrFlag(shareUrl || fallbackUrl);

    const ttlSeconds = minutesToShareTTL(form.ttlMinutes);
    const ttlLabel = formatShareDuration(ttlSeconds, (key: string, params?: Record<string, unknown>) => t(key, params as never));

    const copyToClipboard = async (value: string, successKey = 'copySuccess') => {
        try {
            await copyTextToClipboard(value);
            toast(t(successKey));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const confirmShare = async () => {
        const ttl = normalizeShareTTL(ttlSeconds);
        const maxUses = normalizeShareMaxUses(form.maxUses);
        const password = String(form.password || '').trim();
        setLoading(true);
        try {
            const data = await createShareLink({ type: 'content', id: meta?.id, ttl, maxUses, password, room });
            // ⚠️ 主机名不能用服务端那份：它是按**请求的 Host** 拼的，中间只要有改写 Host 的代理就错
            // （dev 的 vite proxy 写了 changeOrigin: true）。换成浏览器自己的 origin，路径照原样保留。
            const url = withCurrentOrigin(data?.pageUrl) || withCurrentOrigin(data?.url) || fallbackUrl;
            setShareUrl(url);
            setSettingsOpen(false);
            setResultOpen(true);
            await copyToClipboard(url);
        } catch (error) {
            console.error('生成分享链接失败:', error);
            toast(t('copyFailedGeneral'));
        } finally {
            setLoading(false);
        }
    };

    const openShare = () => {
        // 「分享时弹出设置框」关掉时，直接用设置里存好的默认值建链接，不弹框。
        if (!shareDialogEnabled) {
            setForm({ ...shareDefaults });
            void confirmShare();
            return;
        }
        setForm({ ttlMinutes: SHARE_DEFAULT_TTL_MINUTES, maxUses: 0, password: '' });
        setSettingsOpen(true);
    };

    const button = iconOnly ? (
        <Tooltip title={t('shareLink')}>
            <IconButton size="small" className={className} onClick={(e) => { e.stopPropagation(); openShare(); }} aria-label={t('shareLink')}>
                <MdiIcon name="mdi-share-variant" size={18} />
            </IconButton>
        </Tooltip>
    ) : (
        <Button size="small" variant="text" className={className} startIcon={<MdiIcon name="mdi-share-variant" size={16} />} onClick={(e) => { e.stopPropagation(); openShare(); }}>
            {t('shareLink')}
        </Button>
    );

    if (iconOnly && !cardShare) {
        return null;
    }

    return (
        <>
            {button}

            <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle>{t('shareLinkSettings')}</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{t('shareLinkSettingsHint')}</Typography>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="subtitle2">{t('shareExpireIn')}</Typography>
                        <Typography variant="body2" color="primary" fontWeight={500}>{ttlLabel}</Typography>
                    </Stack>
                    <input
                        type="range"
                        min={SHARE_MIN_TTL_MINUTES}
                        max={SHARE_MAX_TTL_MINUTES}
                        step={1}
                        value={form.ttlMinutes}
                        aria-label={t('shareExpireIn')}
                        onChange={(e) => setForm((prev) => ({ ...prev, ttlMinutes: Number(e.target.value) }))}
                        style={{ width: '100%', margin: '8px 0' }}
                    />
                    <Stack direction="row" spacing={0.75} sx={{ mb: 1, flexWrap: 'wrap' }}>
                        {(SHARE_TTL_PRESET_MINUTES as number[]).map((minutes) => (
                            <Chip
                                key={minutes}
                                size="small"
                                label={formatShareDuration(minutesToShareTTL(minutes), (key: string, params?: Record<string, unknown>) => t(key, params as never))}
                                variant={form.ttlMinutes === minutes ? 'filled' : 'outlined'}
                                color={form.ttlMinutes === minutes ? 'primary' : 'default'}
                                onClick={() => setForm((prev) => ({ ...prev, ttlMinutes: minutes }))}
                            />
                        ))}
                    </Stack>
                    <div style={{ height: 6, borderRadius: 999, background: 'color-mix(in srgb, currentColor 18%, transparent)', marginBottom: 16 }}>
                        <div style={{ height: 6, borderRadius: 999, background: 'var(--mui-palette-primary-main)', width: `${shareTtlProgress(form.ttlMinutes)}%` }} />
                    </div>
                    <TextField
                        fullWidth
                        size="small"
                        type="number"
                        label={t('shareMaxUses')}
                        helperText={t('shareMaxUsesHint')}
                        value={form.maxUses}
                        slotProps={{ htmlInput: { min: 0, max: SHARE_MAX_USES_LIMIT } }}
                        onChange={(e) => setForm((prev) => ({ ...prev, maxUses: Number(e.target.value) }))}
                        sx={{ mb: 2 }}
                    />
                    <TextField
                        fullWidth
                        size="small"
                        type="password"
                        autoComplete="new-password"
                        label={t('sharePasswordLabel')}
                        helperText={t('sharePasswordHint')}
                        value={form.password}
                        onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                    />
                </DialogContent>
                <DialogActions>
                    <Button variant="text" onClick={() => setSettingsOpen(false)}>{t('cancel')}</Button>
                    <Button variant="text" color="primary" loading={loading} onClick={confirmShare}>{t('generateAndCopy')}</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={resultOpen} onClose={() => setResultOpen(false)} maxWidth="xs" fullWidth>
                <DialogTitle sx={{ textAlign: 'center' }}>{t('shareLink')}</DialogTitle>
                <DialogContent sx={{ textAlign: 'center' }}>
                    <QRCodeSVG value={qrUrl} size={200} level="H" />
                    <Typography variant="caption" sx={{ display: 'block', mt: 1, wordBreak: 'break-all' }}>
                        {shareUrl || fallbackUrl}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        {t('shareOpenedTimes', { count: 0 })} · {t('shareOpenedHint')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {formatTimestamp(Math.floor(Date.now() / 1000) + ttlSeconds)}
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button variant="text" color="primary" startIcon={<MdiIcon name="mdi-content-copy" size={16} />} onClick={() => copyToClipboard(shareUrl || fallbackUrl, 'copySuccess')}>
                        {t('copyLink')}
                    </Button>
                    <Button variant="text" onClick={() => setResultOpen(false)}>{t('close')}</Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
