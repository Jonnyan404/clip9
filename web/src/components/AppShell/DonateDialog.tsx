import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { MdiIcon } from '@/components/ui/MdiIcon';

/** 赞助 / 推广弹窗 —— 对应 web-vue3/src/App.vue 里的 `donateDialog`（内容逐条照搬）。 */
export function DonateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <MdiIcon name="mdi-heart-outline" color="#ff5252" />
                {t('donatePrompt')}
            </DialogTitle>
            <Divider />
            <DialogContent sx={{ textAlign: 'center' }}>
                <Typography variant="body2" fontWeight={500} sx={{ mb: 1 }}>{t('supportSectionTitle')}</Typography>
                <Stack direction="row" spacing={2} justifyContent="center">
                    <div>
                        <Typography variant="caption" display="block">微信</Typography>
                        <img src="/reward-wechat.png" alt="WeChat Reward QR" style={{ maxWidth: 150, borderRadius: 8 }} />
                    </div>
                    <div>
                        <Typography variant="caption" display="block">支付宝</Typography>
                        <img src="/reward-alipay.png" alt="Alipay Reward QR" style={{ maxWidth: 150, borderRadius: 8 }} />
                    </div>
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2, whiteSpace: 'pre-line' }}>
                    {t('rewardHint')}
                </Typography>
                <Button
                    fullWidth
                    sx={{ mt: 2, bgcolor: '#ff5f5f', color: '#fff' }}
                    href="https://ko-fi.com/jonnyan404"
                    target="_blank"
                    rel="noopener"
                    startIcon={<MdiIcon name="mdi-coffee" />}
                    endIcon={<MdiIcon name="mdi-open-in-new" size={16} />}
                >
                    Buy Me a Coffee
                </Button>
                <Divider sx={{ my: 3 }} />
                <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
                    {t('cloudPromoHint')}
                </Typography>
                <Stack spacing={1} sx={{ mt: 2 }}>
                    <Button
                        variant="outlined"
                        startIcon={<MdiIcon name="mdi-currency-cny" />}
                        endIcon={<MdiIcon name="mdi-open-in-new" size={16} />}
                        href="https://cloud.tencent.com/act/cps/redirect?redirect=6150&cps_key=0b1dfaf9bb573dac05abef76202dc8cc&from=console"
                        target="_blank"
                        rel="noopener"
                    >
                        腾讯云 2C2G ¥99/年
                    </Button>
                    <Button
                        variant="outlined"
                        startIcon={<MdiIcon name="mdi-currency-cny" />}
                        endIcon={<MdiIcon name="mdi-open-in-new" size={16} />}
                        href="https://www.aliyun.com/daily-act/ecs/activity_selection?userCode=79h2wrag"
                        target="_blank"
                        rel="noopener"
                    >
                        阿里云 2C2G ¥99/年
                    </Button>
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button variant="text" color="primary" onClick={onClose}>{t('close')}</Button>
            </DialogActions>
        </Dialog>
    );
}
