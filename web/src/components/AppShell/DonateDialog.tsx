import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { MdiIcon } from '@/components/ui/MdiIcon';

/**
 * 赞助 / 推广弹窗 —— 对应 web-vue3/src/App.vue 里的 `donateDialog`（内容逐条照搬）。
 *
 * ⚠️★ 它有**两个入口**，共用这一份定义：
 *   · 设置 → 「喜欢这个工具的话…」（标题用 `donatePrompt`）；
 *   · 标准模式输入区页脚的「赞赏支持」图标（标题用 `rewardTitle`，且不再重复一条分组标题）。
 * 之前这两处各写了一份，结果输入区那份**漏掉了腾讯云 / 阿里云两个按钮** ——
 * `cloudPromoHint` 那句「可以看看这些活动价 👇」指着空气。**别再拆成两份。**
 */
export function DonateDialog({
    open,
    onClose,
    titleKey = 'donatePrompt',
    showSectionTitle = true,
}: {
    open: boolean;
    onClose: () => void;
    /** 标题文案的 i18n 键。 */
    titleKey?: string;
    /** 是否显示正文顶部那条分组标题。输入区入口的标题与它同义，那里传 `false` 免得重复。 */
    showSectionTitle?: boolean;
}) {
    const { t } = useTranslation();

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <MdiIcon name="mdi-heart-outline" color="#ff5252" />
                {t(titleKey)}
            </DialogTitle>
            <Divider />
            <DialogContent sx={{ textAlign: 'center' }}>
                {showSectionTitle && (
                    <Typography variant="body2" fontWeight={500} sx={{ mb: 1 }}>{t('supportSectionTitle')}</Typography>
                )}
                {/* ⚠️ 两张码要**能缩**：固定 150px 两张并排是 316px，窄屏（360px 的手机）放不下，
                    会被裁掉。用 flex:1 + maxWidth 让它们在窄屏各自缩到一半。 */}
                <Stack direction="row" spacing={2} justifyContent="center">
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="caption" display="block">微信</Typography>
                        <img
                            src="/reward-wechat.png"
                            alt="WeChat Reward QR"
                            style={{ display: 'block', width: '100%', maxWidth: 150, height: 'auto', margin: '0 auto', borderRadius: 8 }}
                        />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="caption" display="block">支付宝</Typography>
                        <img
                            src="/reward-alipay.png"
                            alt="Alipay Reward QR"
                            style={{ display: 'block', width: '100%', maxWidth: 150, height: 'auto', margin: '0 auto', borderRadius: 8 }}
                        />
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
