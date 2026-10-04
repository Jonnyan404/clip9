import { useMemo, useState } from 'react';
import { Button, ButtonGroup, Dialog, DialogContent, DialogTitle, IconButton, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';
import { router } from '@/router';
import { copyTextToClipboard } from '@/lib/util';
import { useAppStore } from '@/stores/appStore';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';
import { MdiIcon } from '@/components/ui/MdiIcon';

/**
 * 页面二维码 —— 对应 web-vue3/src/App.vue 里的 `pageQrDialogVisible`。
 * 两种模式：**当前页**（连同当前房间）与**最新内容**（`content/latest`）。
 */
export function PageQrDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const room = useWebSocketStore((s) => s.room);
    const [mode, setMode] = useState<'page' | 'latest'>('page');

    const currentPageUrl = useMemo(() => {
        const params = new URLSearchParams();
        if (room) params.set('room', room);
        const search = params.toString();
        return new URL(`${router.state.location.pathname}${search ? `?${search}` : ''}`, window.location.origin).toString();
    }, [room]);

    const latestContentUrl = useMemo(() => {
        const roomQuery = room ? `?room=${encodeURIComponent(room)}` : '';
        const normalized = `content/latest${roomQuery}`.replace(/^\/+/, '');
        const baseURL = axios.defaults.baseURL || '';
        if (baseURL) {
            return new URL(normalized, `${baseURL.replace(/\/+$/, '')}/`).toString();
        }
        const prefix = useAppStore.getState().config?.server?.prefix || '';
        return new URL(`${prefix}/${normalized}`, `${window.location.origin}/`).toString();
    }, [room]);

    const url = mode === 'latest' ? latestContentUrl : currentPageUrl;

    const copyUrl = async () => {
        try {
            await copyTextToClipboard(url);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {t('scanToAccess')}
                <span style={{ flex: 1 }} />
                <IconButton size="small" onClick={onClose} aria-label={t('close')}>
                    <MdiIcon name="mdi-close" size={18} />
                </IconButton>
            </DialogTitle>
            <DialogContent sx={{ textAlign: 'center', pb: 3 }}>
                <ButtonGroup size="small" sx={{ mb: 2 }}>
                    <Button variant={mode === 'page' ? 'contained' : 'outlined'} onClick={() => setMode('page')}>
                        {t('currentShare')}
                    </Button>
                    <Button variant={mode === 'latest' ? 'contained' : 'outlined'} onClick={() => setMode('latest')}>
                        {t('latestShare')}
                    </Button>
                </ButtonGroup>
                <div>
                    <QRCodeSVG value={url} size={200} level="H" />
                </div>
                <Typography
                    variant="caption"
                    onClick={copyUrl}
                    sx={{ mt: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5, cursor: 'pointer', wordBreak: 'break-all' }}
                    title={t('copyLink')}
                >
                    <span>{url}</span>
                    <MdiIcon name="mdi-content-paste" size={16} />
                </Typography>
            </DialogContent>
        </Dialog>
    );
}
