import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useWebSocketStore } from '@/stores/wsStore';
import { randomRoomName, useRoomsStore } from '@/stores/roomsStore';
import { MdiIcon } from '@/components/ui/MdiIcon';

/**
 * 「进入房间」弹窗 —— 对应 web-vue3/src/App.vue 里的 `ws.roomDialog` 那个 `<v-dialog>`。
 *
 * ⚠️ 提交时先 `ensureRoomPresent`（把新房间插进侧栏列表），再 `navigateToRoom` ——
 * `navigateToRoom` **带鉴权判断**，受保护的房间会接着弹出密码框。
 */
export function RoomDialog() {
    const { t } = useTranslation();
    const open = useWebSocketStore((s) => s.roomDialog);
    const roomInput = useWebSocketStore((s) => s.roomInput);
    const navigateToRoom = useWebSocketStore((s) => s.navigateToRoom);
    const ensureRoomPresent = useRoomsStore((s) => s.ensureRoomPresent);

    const submit = () => {
        const name = roomInput || '';
        ensureRoomPresent(name);
        useWebSocketStore.setState({ roomDialog: false });
        void navigateToRoom(name);
    };

    return (
        <Dialog open={open} onClose={() => useWebSocketStore.setState({ roomDialog: false })} maxWidth="xs" fullWidth>
            <DialogTitle>{t('clipboardRoom')}</DialogTitle>
            <DialogContent>
                <Typography variant="body2">{t('roomPrompt1')}</Typography>
                <Typography variant="body2" sx={{ mb: 2 }}>{t('roomPrompt2')}</Typography>
                <TextField
                    autoFocus
                    fullWidth
                    label={t('roomName')}
                    value={roomInput}
                    onChange={(e) => useWebSocketStore.setState({ roomInput: e.target.value })}
                    onKeyUp={(e) => {
                        if (e.key === 'Enter') submit();
                    }}
                    slotProps={{
                        input: {
                            endAdornment: (
                                <InputAdornment position="end">
                                    <IconButton
                                        size="small"
                                        title={t('randomRoomName')}
                                        onClick={() => useWebSocketStore.setState({ roomInput: randomRoomName() })}
                                    >
                                        <MdiIcon name="mdi-dice-multiple" size={18} />
                                    </IconButton>
                                </InputAdornment>
                            ),
                        },
                    }}
                />
            </DialogContent>
            <DialogActions>
                <Button variant="text" onClick={() => useWebSocketStore.setState({ roomDialog: false })}>
                    {t('cancel')}
                </Button>
                <Button variant="text" color="primary" onClick={submit}>
                    {t('enterRoom')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
