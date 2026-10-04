import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { errorMessage } from '@/lib/util';
import { useWebSocketStore } from '@/stores/wsStore';
import { toast } from '@/stores/toastStore';

/**
 * 「清空剪贴板」确认弹窗 —— 对应 web-vue3/src/App.vue 里的 `clearAllDialog`。
 *
 * ⚠️ 破坏性动作，所以先确认；成功后由外壳显示一条「已清空，建议刷新」的提示条。
 */
export function ClearAllDialog({
    open,
    onClose,
    onCleared,
}: {
    open: boolean;
    onClose: () => void;
    onCleared: (visible: boolean) => void;
}) {
    const { t } = useTranslation();

    const confirm = async () => {
        onClose();
        onCleared(true);
        try {
            await axios.delete('revoke/all', {
                params: { room: useWebSocketStore.getState().room },
            });
        } catch (error) {
            console.error(error);
            onCleared(false);
            const msg = errorMessage(error);
            if (msg) {
                toast(t('clearClipboardFailedMsg', { msg }));
            } else {
                toast(t('clearClipboardFailed'));
            }
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>{t('clearClipboardConfirmTitle')}</DialogTitle>
            <DialogContent>
                <Typography variant="body2">{t('clearClipboardConfirmText')}</Typography>
            </DialogContent>
            <DialogActions>
                <Button variant="text" onClick={onClose}>{t('cancel')}</Button>
                <Button variant="text" color="primary" onClick={confirm}>{t('ok')}</Button>
            </DialogActions>
        </Dialog>
    );
}
