import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { useWebSocketStore } from '@/stores/wsStore';

/**
 * 房间密码弹窗 —— 对应 web-vue3/src/App.vue 里的 `ws.authCodeDialog` 那个 `<v-dialog>`。
 *
 * ⚠️ 状态在 wsStore 里（受保护的房间被打开、token 失效、WS 重试耗尽都会把它弹出来）。
 * `authCodeError` 存的是**文案键**（`authInvalid` / `connectionFailedRetry`），在这里翻译。
 */
export function AuthDialog() {
    const { t } = useTranslation();
    const open = useWebSocketStore((s) => s.authCodeDialog);
    const loading = useWebSocketStore((s) => s.authDialogLoading);
    const errorKey = useWebSocketStore((s) => s.authCodeError);
    const pendingRoom = useWebSocketStore((s) => s.authPendingRoom);
    const room = useWebSocketStore((s) => s.room);
    const submit = useWebSocketStore((s) => s.submitAuthCodeForPendingRoom);

    // 密码输入框是**本地** state：提交成功由 store 关弹窗，失败由 store 置错误。
    const [password, setPassword] = useState('');
    const targetRoom = pendingRoom || room;

    const handleSubmit = () => {
        useWebSocketStore.setState({ inputPassword: password });
        void submit();
    };

    return (
        <Dialog
            open={open}
            onClose={() => { /* persistent：必须提交 */ }}
            maxWidth="xs"
            fullWidth
            disableEscapeKeyDown
        >
            <DialogTitle>{t('authRequired')}</DialogTitle>
            <DialogContent>
                <Typography variant="body2">{t('authPrompt')}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 2 }}>
                    {t('room')}: {targetRoom || t('publicRoom')}
                </Typography>
                <TextField
                    autoFocus
                    fullWidth
                    type="password"
                    label={t('password')}
                    value={password}
                    disabled={loading}
                    error={Boolean(errorKey)}
                    helperText={errorKey ? t(errorKey) : undefined}
                    onChange={(e) => {
                        setPassword(e.target.value);
                        useWebSocketStore.setState({ authCodeError: '' });
                    }}
                    onKeyUp={(e) => {
                        if (e.key === 'Enter') handleSubmit();
                    }}
                />
            </DialogContent>
            <DialogActions>
                <Button variant="text" color="primary" loading={loading} onClick={handleSubmit}>
                    {t('submit')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
