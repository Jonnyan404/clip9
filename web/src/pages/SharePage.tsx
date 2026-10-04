import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import {
    Alert, Box, Button, Card, Chip, CircularProgress, LinearProgress, Stack, TextField, Typography,
} from '@mui/material';
import axios from 'axios';
import { CodeBlock } from '@/components/CodeBlock';
import { MarkdownBody } from '@/components/MarkdownBody';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { toast } from '@/stores/toastStore';
import {
    copyTextToClipboard, errorMessage, filePreviewKind, formatTimestamp, prettyFileSize,
} from '@/lib/util';
import { renderMarkdownHtml as renderMd } from '@/lib/markdown.js';
import { reportShareVisit } from '@/services/share';

interface ShareInfo {
    kind?: string;
    id?: string | number;
    uuid?: string;
    name?: string;
    size?: number;
    room?: string;
    expiresAt?: number;
    maxUses?: number;
    used?: number;
    previewToken?: string;
}

/**
 * 分享页 —— 从 web-vue3/src/views/ShareView.vue 移植。
 *
 * ⚠️★ 这一页由**服务端外壳**（rust/crates/server/src/spa_shell.rs）注入 OG 后下发：
 * 抓取程序与真人拿的是同一份 HTML、同一个地址（`<prefix>/s/<token>`）。
 * ⚠️ 这一页**不建 WebSocket、不碰房间状态、不装宿主桥**（见 services/bootstrap.ts）。
 * ⚠️ 接口一律用**相对路径**（不带前导斜杠），由 axios 的 baseURL 落到 `<prefix>/`。
 * ⚠️ 同一条路由上换 token **不会重新挂载组件** —— 必须盯住 token 重载，否则会一直显示上一条分享。
 *
 * ⚠️★ `share-page` / `share-page__raw` / `share-page__center--form` / `share-page__image` 这几个
 * **结构类名是刻意保留的契约**：`tools/share-page-acceptance.mjs` 按它们定位元素（不按文案，
 * 因为文案挂在 locale 上）。改成 MUI 之后 DOM 结构变了，所以把这些钩子显式补回来 ——
 * 否则那条真浏览器验收会红，而**红的原因跟功能无关**，属于最难查的一类。
 */
export default function SharePage() {
    const { t } = useTranslation();
    const { token: tokenParam } = useParams<{ token?: string }>();
    const [searchParams] = useSearchParams();
    const token = String(tokenParam || '');
    const linkedFormat = String(searchParams.get('f') || '').toLowerCase() === 'md' ? 'md' : 'raw';

    const [loading, setLoading] = useState(true);
    const [info, setInfo] = useState<ShareInfo | null>(null);
    const [text, setText] = useState('');
    const [mdMode, setMdMode] = useState<'raw' | 'md'>('raw');
    const [password, setPassword] = useState('');
    const [passwordNeeded, setPasswordNeeded] = useState(false);
    const [passwordError, setPasswordError] = useState(false);
    const [failure, setFailure] = useState('');
    const [fileText, setFileText] = useState('');
    const [previewLoading, setPreviewLoading] = useState(false);

    // 分享页的 401 是**预期内**的（要密码），不能让全局拦截器弹「房间鉴权」对话框。
    const shareConfig = useCallback((extra: Record<string, unknown> = {}) => ({
        ...extra,
        headers: password ? { 'X-Share-Password': password } : undefined,
        __skipRoomAuthHandling: true,
    }), [password]);

    const isFile = info?.kind === 'file';
    const isText = info?.kind === 'text';
    const html = useMemo(() => (mdMode === 'md' ? renderMd(text) : ''), [mdMode, text]);
    const canToggleMd = Boolean(isText && text);

    // ⚠️ 文件地址用的令牌**不能直接用原 token** —— `<img>` / `<video>` / `<a download>` 是浏览器
    // 自己发的请求，加不了 `X-Share-Password` 头；带密码的分享会一律 401。
    const fileToken = String(info?.previewToken || '') || token;
    const fileUrl = isFile && info?.uuid
        ? `file/${encodeURIComponent(info.uuid)}/${encodeURIComponent(info.name || 'file')}?t=${encodeURIComponent(fileToken)}`
        : '';
    const previewKind = isFile ? filePreviewKind(info?.name) : '';

    const shareFailureText = (code: string) => {
        switch (code) {
            case 'share_token_invalid': return t('sharePageInvalid');
            case 'file_expired': return t('sharePageExpired');
            case 'content_not_found':
            case 'file_not_found': return t('sharePageNotFound');
            default: return '';
        }
    };

    const loadInfo = useCallback(async () => {
        setLoading(true);
        setFailure('');
        setFileText('');
        if (!token) {
            setFailure(t('sharePageInvalid'));
            setLoading(false);
            return;
        }
        try {
            const { data } = await axios.get('share', shareConfig({ params: { t: token } }));
            setInfo(data);
            setPasswordNeeded(false);
            setPasswordError(false);
            setMdMode(linkedFormat);
            if (data?.kind === 'text') {
                const params: Record<string, string> = { format: 'json', t: token };
                if (data.room) params.room = data.room;
                const response = await axios.get(`content/${encodeURIComponent(data.id)}`, shareConfig({ params }));
                setText(response.data?.content ?? '');
            } else if (data?.kind === 'file') {
                const kind = filePreviewKind(data.name);
                if (kind === 'text') {
                    setPreviewLoading(true);
                    try {
                        const url = `file/${encodeURIComponent(data.uuid)}/${encodeURIComponent(data.name || 'file')}?t=${encodeURIComponent(data.previewToken || token)}`;
                        const response = await axios.get(url, shareConfig({ responseType: 'text' }));
                        setFileText(typeof response.data === 'string' ? response.data : String(response.data || ''));
                    } catch (error) {
                        // 预览失败**不**把整页变成错误页 —— 下面那行「名字 + 大小 + 下载」还在。
                        console.warn('share file preview failed:', errorMessage(error));
                    } finally {
                        setPreviewLoading(false);
                    }
                }
            }
        } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status;
            const code = String((error as { response?: { data?: { code?: string } } })?.response?.data?.code || '');
            if (status === 401 && code === 'share_password_required') {
                // 第一次进来是「要密码」，带了密码还进来才是「密码不对」
                setPasswordError(Boolean(password));
                setPasswordNeeded(true);
                setInfo(null);
                setText('');
                setFileText('');
                return;
            }
            setFailure(shareFailureText(code) || errorMessage(error) || t('sharePageInvalid'));
        } finally {
            setLoading(false);
        }
    }, [token, password, linkedFormat, shareConfig, t]);

    // 上报「有真人打开了这条分享」—— 只有执行了 JS 的这一页能证明是真人（抓取程序不跑 JS）。
    const reportVisit = useCallback(() => {
        if (!token) return;
        void reportShareVisit(token, { qr: String(searchParams.get('q') || '') === '1' });
    }, [token, searchParams]);

    useEffect(() => {
        // 换 token 时把上一条的状态全部清掉（同一条路由不会重新挂载组件）。
        setPassword('');
        setPasswordNeeded(false);
        setPasswordError(false);
        setFailure('');
        setInfo(null);
        setText('');
        setFileText('');
        setMdMode(linkedFormat);
        reportVisit();
        void loadInfo();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const copyContent = async () => {
        try {
            await copyTextToClipboard(text);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    const roomLabel = (() => {
        const room = String(info?.room || 'default');
        return room === 'default' ? t('publicRoom') : room;
    })();

    return (
        <Box className="share-page" sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', minHeight: '100dvh', p: { xs: 2, sm: 4 } }}>
            <Card variant="outlined" sx={{ width: '100%', maxWidth: 720, p: 2.5 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                    <MdiIcon name="mdi-lock-outline" size={20} />
                    <Typography sx={{ fontSize: '0.95rem', fontWeight: 500, flex: 1 }}>{t('sharePageTitle')}</Typography>
                </Stack>

                {loading && <LinearProgress sx={{ mt: 1.5 }} />}

                {loading && (
                    <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}>
                        <CircularProgress size={28} />
                        <Typography variant="body2" color="text.secondary">{t('sharePageLoading')}</Typography>
                    </Stack>
                )}

                {!loading && passwordNeeded && (
                    <Stack className="share-page__center--form" alignItems="center" spacing={1.75} sx={{ py: 5 }}>
                        <MdiIcon name="mdi-lock-outline" size={34} color="var(--mui-palette-primary-main)" />
                        <Typography variant="body2" color="text.secondary">{t('sharePagePasswordHint')}</Typography>
                        <TextField
                            type="password"
                            autoComplete="off"
                            label={t('sharePagePasswordLabel')}
                            value={password}
                            error={passwordError}
                            helperText={passwordError ? t('sharePagePasswordWrong') : undefined}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyUp={(e) => { if (e.key === 'Enter' && password) void loadInfo(); }}
                            sx={{ maxWidth: 280, width: '100%' }}
                        />
                        <Button variant="contained" disabled={!password} onClick={() => void loadInfo()}>
                            {t('sharePagePasswordSubmit')}
                        </Button>
                    </Stack>
                )}

                {!loading && !passwordNeeded && failure && (
                    <Stack alignItems="center" spacing={1.5} sx={{ py: 5 }}>
                        <MdiIcon name="mdi-alert-circle-outline" size={34} color="var(--mui-palette-error-main)" />
                        <Typography variant="body2" color="text.secondary">{failure}</Typography>
                    </Stack>
                )}

                {!loading && !passwordNeeded && !failure && info && (
                    <>
                        <Stack direction="row" alignItems="center" spacing={1.25} sx={{ flexWrap: 'wrap', mt: 1.75 }}>
                            <Chip size="small" variant="outlined" label={roomLabel} />
                            {info.expiresAt && (
                                <Typography variant="caption" color="text.secondary">
                                    {t('sharePageExpires', { time: formatTimestamp(info.expiresAt) })}
                                </Typography>
                            )}
                            <Typography variant="caption" color="text.secondary">
                                {info.maxUses
                                    ? t('shareUsesLimited', { count: Math.max(0, Number(info.maxUses) - Number(info.used || 0)) })
                                    : t('shareUsesUnlimited')}
                            </Typography>
                        </Stack>

                        {isText && (
                            <>
                                <Stack direction="row" alignItems="center" sx={{ my: 1 }}>
                                    {canToggleMd && (
                                        <Button
                                            size="small"
                                            variant="text"
                                            startIcon={<MdiIcon name={mdMode === 'md' ? 'mdi-code-tags' : 'mdi-language-markdown'} size={16} />}
                                            onClick={() => setMdMode((m) => (m === 'md' ? 'raw' : 'md'))}
                                        >
                                            {mdMode === 'md' ? t('rawText') : t('renderMarkdown')}
                                        </Button>
                                    )}
                                    <span style={{ flex: 1 }} />
                                    <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-content-copy" size={16} />} onClick={copyContent}>
                                        {t('copyText')}
                                    </Button>
                                </Stack>
                                {mdMode === 'raw'
                                    ? <pre className="code-block share-page__raw" style={{ maxHeight: '60vh', whiteSpace: 'pre-wrap' }}>{text}</pre>
                                    : <MarkdownBody html={html} />}
                            </>
                        )}

                        {isFile && (
                            <>
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 60, mt: 1.75 }}>
                                    {previewLoading && <CircularProgress size={28} />}
                                    {!previewLoading && previewKind === 'image' && <img className="share-page__image" src={fileUrl} alt={info.name} style={{ maxWidth: '100%', maxHeight: '62vh', borderRadius: 8 }} />}
                                    {!previewLoading && previewKind === 'video' && <video src={fileUrl} controls preload="metadata" style={{ maxWidth: '100%', maxHeight: '62vh', borderRadius: 8 }} />}
                                    {!previewLoading && previewKind === 'audio' && <audio src={fileUrl} controls preload="metadata" style={{ width: '100%' }} />}
                                    {!previewLoading && previewKind === 'text' && fileText && <CodeBlock text={fileText} name={info.name} />}
                                </Box>

                                <Stack direction="row" alignItems="center" spacing={1.75} sx={{ mt: 1.5, p: 2, borderRadius: 2, bgcolor: 'action.hover' }}>
                                    {!previewKind && <MdiIcon name="mdi-file-outline" size={40} />}
                                    <Box sx={{ flex: 1, minWidth: 0 }}>
                                        <Typography variant="body2" fontWeight={500} sx={{ wordBreak: 'break-all' }}>{info.name}</Typography>
                                        <Typography variant="caption" color="text.secondary">{prettyFileSize(Number(info.size || 0))}</Typography>
                                    </Box>
                                    <Button variant="contained" startIcon={<MdiIcon name="mdi-download" size={16} />} href={fileUrl} download>
                                        {t('download')}
                                    </Button>
                                </Stack>
                            </>
                        )}
                    </>
                )}

                {!loading && !passwordNeeded && !failure && !info && (
                    <Stack alignItems="center" sx={{ py: 5 }}>
                        <Alert severity="warning">{t('sharePageInvalid')}</Alert>
                    </Stack>
                )}
            </Card>
        </Box>
    );
}
