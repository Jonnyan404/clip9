import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle, Divider, List, ListItem, ListItemText, Stack, Typography,
} from '@mui/material';
import { errorMessage, formatTimestamp, prettyFileSize } from '@/lib/util';
import { fetchShareRecords } from '@/services/share';
import { useWebSocketStore } from '@/stores/wsStore';
import { MdiIcon } from '@/components/ui/MdiIcon';

/** 分享记录一次拉多少条（与 Vue 版同一个量级）。 */
const SHARE_HISTORY_LIMIT = 50;

interface ShareRecord {
    jti?: string;
    kind?: string;
    name?: string;
    size?: number;
    createdAt?: number;
    expiresAt?: number;
    visits?: number;
    scans?: number;
    used?: number;
    maxUses?: number;
    [key: string]: unknown;
}

/**
 * 分享记录 —— 从 web-vue3/src/components/ShareHistoryDialog.vue 移植。
 * 「这个房间最近分享过什么、被打开了几次」（服务端只有签发时才留记录）。
 */
export function ShareHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [records, setRecords] = useState<ShareRecord[]>([]);
    const [total, setTotal] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await fetchShareRecords({ room: useWebSocketStore.getState().room, limit: SHARE_HISTORY_LIMIT });
            setRecords(Array.isArray(data?.records) ? data.records : []);
            setTotal(Number(data?.total) || 0);
        } catch (err) {
            setError(errorMessage(err) || t('shareHistoryFailed'));
            setRecords([]);
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (open) {
            void load();
        }
    }, [open, load]);

    /** 没有文件名时按类型给一个可读的标题。 */
    const recordTitle = (record: ShareRecord) => {
        const name = String(record?.name || '').trim();
        if (name) return name;
        return record?.kind === 'file' ? t('shareHistoryFile') : t('shareHistoryText');
    };

    const recordSubtitle = (record: ShareRecord) => {
        const parts: string[] = [];
        if (record?.createdAt) parts.push(formatTimestamp(record.createdAt));
        if (record?.kind === 'file' && Number(record?.size) > 0) parts.push(prettyFileSize(Number(record.size)));
        if (record?.maxUses) parts.push(t('shareHistoryUsed', { used: Number(record.used || 0), max: Number(record.maxUses) }));
        return parts.join(' · ');
    };

    const isExpired = (record: ShareRecord) => Boolean(record?.expiresAt && Number(record.expiresAt) * 1000 < Date.now());

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <MdiIcon name="mdi-share-variant" />
                <Box sx={{ flex: 1, lineHeight: 1.3 }}>
                    <div>{t('shareHistory')}</div>
                    <Typography variant="caption" color="text.secondary">{t('shareHistoryHint')}</Typography>
                </Box>
                <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-refresh" size={16} />} disabled={loading} onClick={() => void load()}>
                    {t('shareHistoryRefresh')}
                </Button>
            </DialogTitle>
            <DialogContent dividers>
                {loading && (
                    <Stack alignItems="center" sx={{ py: 4 }}>
                        <CircularProgress size={28} />
                    </Stack>
                )}

                {!loading && error && (
                    <Typography color="error" variant="body2">{error}</Typography>
                )}

                {!loading && !error && records.length === 0 && (
                    <Typography color="text.secondary" variant="body2">{t('shareHistoryEmpty')}</Typography>
                )}

                {!loading && !error && records.length > 0 && (
                    <>
                        <List dense disablePadding>
                            {records.map((record, index) => (
                                <div key={String(record.jti ?? index)}>
                                    <ListItem
                                        disableGutters
                                        secondaryAction={
                                            <Stack direction="row" spacing={1.5} alignItems="center">
                                                <Typography variant="caption" color="text.secondary">
                                                    {t('shareHistoryOpened', { count: Number(record.visits || 0) })}
                                                </Typography>
                                                {Number(record.scans) > 0 && (
                                                    <Typography variant="caption" color="text.secondary">
                                                        {t('shareHistoryScanned', { count: Number(record.scans) })}
                                                    </Typography>
                                                )}
                                                {isExpired(record) && (
                                                    <Typography variant="caption" color="error">
                                                        {t('shareHistoryExpired')}
                                                    </Typography>
                                                )}
                                            </Stack>
                                        }
                                    >
                                        <MdiIcon
                                            name={record.kind === 'file' ? 'mdi-file-outline' : 'mdi-text-box-outline'}
                                            size={18}
                                            style={{ marginRight: 8 }}
                                        />
                                        <ListItemText
                                            primary={recordTitle(record)}
                                            secondary={recordSubtitle(record)}
                                            slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true, variant: 'caption' } }}
                                        />
                                    </ListItem>
                                    {index < records.length - 1 && <Divider component="li" />}
                                </div>
                            ))}
                        </List>
                        {total > records.length && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                {t('shareHistoryMore', { shown: records.length, total })}
                            </Typography>
                        )}
                    </>
                )}

                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    {t('shareHistoryPrivacyHint')}
                </Typography>
            </DialogContent>
        </Dialog>
    );
}
