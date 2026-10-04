import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, DialogContent, DialogTitle, Divider, Stack, Typography } from '@mui/material';
import { buildAppUrl } from '@/lib/util';
import { MdiIcon } from '@/components/ui/MdiIcon';

/** Apple 捷径的产物清单（源在仓库根的 `shortcuts/apple/`，构建时同步到 `public/shortcuts/`）。 */
const APPLE_SHORTCUTS = [
    'Clip9-Receive.shortcut',
    'Clip9-Receive-By-ID.shortcut',
    'Clip9-Send-Text.shortcut',
    'Clip9-Send-File.shortcut',
];

/**
 * 快捷指令下载 —— 对应 web-vue3/src/components/ShortcutsDialog.vue。
 *
 * ⚠️ 地址走 `buildAppUrl`（相对**应用基准目录**）而不是 `config.server.prefix`：
 * prefix 要等 WS 握手的 `config` 事件才有，而这个弹窗可能在那一刻之前就打开
 * （Vue 版为这个坑写了一大段注释，结论一致）。
 * ⚠️ 更新日期来自 `shortcuts/meta.json`（由 `scripts/sync-shortcuts.mjs` 生成）。
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const [meta, setMeta] = useState<{ apple?: string[]; android?: string[] }>({});

    useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        fetch(buildAppUrl('shortcuts/meta.json'))
            .then((response) => (response.ok ? response.json() : {}))
            .then((data) => {
                if (!cancelled) setMeta(data && typeof data === 'object' ? data : {});
            })
            .catch(() => { /* 读不到就当作「没有更新记录」，下载照常 */ });
        return () => {
            cancelled = true;
        };
    }, [open]);

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>{t('shortcuts')}</DialogTitle>
            <DialogContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('shortcutsHint')}</Typography>

                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('shortcutsApple')}</Typography>
                {meta.apple?.[0] && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                        {meta.apple.join(' · ')}
                    </Typography>
                )}
                <Stack spacing={1}>
                    {APPLE_SHORTCUTS.map((name) => (
                        <Button
                            key={name}
                            variant="outlined"
                            startIcon={<MdiIcon name="mdi-download" size={16} />}
                            href={buildAppUrl(`shortcuts/apple/${name}`)}
                            download
                        >
                            {name.replace('.shortcut', '')}
                        </Button>
                    ))}
                </Stack>

                <Divider sx={{ my: 2 }} />

                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('shortcutsAndroid')}</Typography>
                {meta.android?.[0] && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                        {meta.android.join(' · ')}
                    </Typography>
                )}
                <Button
                    fullWidth
                    variant="outlined"
                    startIcon={<MdiIcon name="mdi-download" size={16} />}
                    href={buildAppUrl('shortcuts/android/shortcuts.zip')}
                    download
                >
                    {t('download')}
                </Button>
            </DialogContent>
        </Dialog>
    );
}
