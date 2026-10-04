import { useEffect, useState } from 'react';
import { CircularProgress, Dialog, DialogContent, DialogTitle, Divider, List, ListItem, ListItemText, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { errorMessage, formatTimestamp } from '@/lib/util';
import { fetchShareRecords } from '@/services/share';
import { useWebSocketStore } from '@/stores/wsStore';

/** 分享记录一次拉多少条（与 Vue 版同一个量级）。 */
const SHARE_HISTORY_LIMIT = 50;

interface ShareRecord {
    id?: string | number;
    type?: string;
    name?: string;
    createdAt?: number;
    visits?: number;
    [key: string]: unknown;
}

/**
 * 分享记录 —— 对应 web-vue3/src/components/ShareHistoryDialog.vue。
 * 「这个房间最近分享过什么、被打开了几次」（服务端只有签发时才留记录）。
 */
export function ShareHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [records, setRecords] = useState<ShareRecord[]>([]);

    useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError('');
        void (async () => {
            try {
                const data = await fetchShareRecords({ room: useWebSocketStore.getState().room, limit: SHARE_HISTORY_LIMIT });
                if (cancelled) return;
                setRecords(Array.isArray(data?.records) ? data.records : []);
            } catch (err) {
                if (cancelled) return;
                setError(errorMessage(err) || t('shareHistoryFailed'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, t]);

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>{t('shareHistory')}</DialogTitle>
            <DialogContent dividers>
                {loading && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                        <CircularProgress size={28} />
                    </div>
                )}
                {!loading && error && (
                    <Typography color="error" variant="body2">{error}</Typography>
                )}
                {!loading && !error && records.length === 0 && (
                    <Typography color="text.secondary" variant="body2">{t('shareHistoryEmpty')}</Typography>
                )}
                {!loading && !error && records.length > 0 && (
                    <>
                        <Typography variant="caption" color="text.secondary">
                            {t('shareHistoryHint')}
                        </Typography>
                        <List dense>
                            {records.map((record, index) => (
                                <div key={String(record.id ?? index)}>
                                    <ListItem disableGutters>
                                        <ListItemText
                                            primary={record.name || record.type || '—'}
                                            secondary={record.createdAt ? formatTimestamp(record.createdAt) : ''}
                                        />
                                        <Typography variant="caption" color="text.secondary">
                                            {t('shareOpenedTimes', { count: Number(record.visits) || 0 })}
                                        </Typography>
                                    </ListItem>
                                    {index < records.length - 1 && <Divider component="li" />}
                                </div>
                            ))}
                        </List>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
