import { Alert, Snackbar } from '@mui/material';
import { useToastStore } from '@/stores/toastStore';

/**
 * 全局 toast 的渲染出口 —— 对应 web-vue3/src/App.vue 里的 `<v-snackbar>`。
 * 数据在 `stores/toastStore.ts`（模块级单例，任何地方都能 `toast(...)`）。
 */
export function ToastHost() {
    const visible = useToastStore((s) => s.visible);
    const text = useToastStore((s) => s.text);
    const color = useToastStore((s) => s.color);
    const timeout = useToastStore((s) => s.timeout);
    const hide = useToastStore((s) => s.hide);

    const severity = color === 'error' ? 'error' : color === 'success' ? 'success' : color === 'info' ? 'info' : undefined;

    return (
        <Snackbar
            open={visible}
            // `-1` 表示「不自动关」（forever / dismissable）
            autoHideDuration={timeout > 0 ? timeout : null}
            onClose={(_event, reason) => {
                if (reason !== 'clickaway') hide();
            }}
            anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        >
            <Alert
                severity={severity ?? 'info'}
                variant={severity ? 'filled' : 'outlined'}
                onClose={hide}
                sx={{ width: '100%', alignItems: 'center' }}
            >
                {text}
            </Alert>
        </Snackbar>
    );
}
