import { Alert, Snackbar, useMediaQuery } from '@mui/material';
import { useToastStore } from '@/stores/toastStore';

/**
 * 全局 toast 的渲染出口 —— 对应 web-vue3/src/App.vue 里的 `<v-snackbar>`。
 * 数据在 `stores/toastStore.ts`（模块级单例，任何地方都能 `toast(...)`）。
 *
 * ⚠️★ 窄屏（2026-10-26 用户报的「移动端提示不明显」）特意和桌面**不一样**：
 *
 *   ① **落到底部**。原来是顶部居中 —— 手机上那一块被工具栏和浏览器地址栏占着，
 *      而人的视线和拇指都在底部（发送区在那儿），一条 3 秒就消失的提示在顶上等于没提示。
 *   ② **实心（filled）+ 投影**。原来没有 severity 的提示走 `outlined`：白底细边，
 *      放在便签墙那种带纹理的花底上几乎看不出来。手机上一律实心，配 `severity` 的底色。
 *   ③ 底部要**让开安全区**（`safe-area-inset-bottom`）：全面屏上贴到最底下会被 Home 条盖住。
 *
 * ⚠️ 桌面保持原样（顶部 + 无 severity 时 outlined）：那一套在浅色页面上够用，
 * 而且顶部居中不会挡住底部的发送区。
 *
 * ⚠️ 阈值 `600px` = MUI 的 `sm`（与 `useMediaQuery(theme.breakpoints.down('sm'))` 同一个值）。
 * 写成裸值是为了这个组件不依赖主题实例（它是 portal 里的叶子，没必要为此 useTheme）。
 */
export function ToastHost() {
    const visible = useToastStore((s) => s.visible);
    const text = useToastStore((s) => s.text);
    const color = useToastStore((s) => s.color);
    const timeout = useToastStore((s) => s.timeout);
    const hide = useToastStore((s) => s.hide);

    const narrow = useMediaQuery('(max-width: 600px)');
    const severity = color === 'error' ? 'error' : color === 'success' ? 'success' : color === 'info' ? 'info' : undefined;

    return (
        <Snackbar
            open={visible}
            // `-1` 表示「不自动关」（forever / dismissable）
            autoHideDuration={timeout > 0 ? timeout : null}
            onClose={(_event, reason) => {
                if (reason !== 'clickaway') hide();
            }}
            anchorOrigin={{ vertical: narrow ? 'bottom' : 'top', horizontal: 'center' }}
            // ⚠️ `mb` 是**在** MUI 给的 `bottom: 24px` 之外再加安全区（margin 撑的是定位元素的外沿）。
            sx={narrow ? { mb: 'calc(8px + env(safe-area-inset-bottom))', maxWidth: 'calc(100% - 24px)' } : undefined}
        >
            <Alert
                severity={severity ?? 'info'}
                // 有 severity 的一直是实心；没有 severity 的（`toast('已复制')` 这类）只在窄屏转实心。
                variant={severity || narrow ? 'filled' : 'outlined'}
                onClose={hide}
                sx={{
                    width: '100%',
                    alignItems: 'center',
                    ...(narrow ? { boxShadow: 6, borderRadius: 2, fontSize: 14, py: 0.75 } : null),
                }}
            >
                {text}
            </Alert>
        </Snackbar>
    );
}
