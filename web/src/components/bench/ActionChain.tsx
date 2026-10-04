import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Divider, IconButton, Menu, Stack, TextField, Typography } from '@mui/material';
import { runChain } from '@/lib/actions/index.js';
import { selectChainSteps, useActionChainStore } from '@/stores/actionChainStore';
import { copyTextToClipboard } from '@/lib/util';
import { toast } from '@/stores/toastStore';
import { MdiIcon } from '@/components/ui/MdiIcon';
import { ActionPicker } from './ActionPicker';

/**
 * 动作链 —— 从 web-vue3/src/components/bench/ActionChain.vue 移植。
 *
 * ⚠️ 结果区**默认只显示链末端的输出**。中间步骤只带一个字数变化（`62 → 47`），
 * 够判断这一步有没有起作用；把每步结果都铺出来会让这一栏变成一坨日志。
 * ⚠️ 动作**不改数据** —— 产出的结果要落盘必须显式点「另存为新条目」。
 * ⚠️ 结果必须防竞态：在列表里快速点几条时，先发起的计算可能后回来。
 */
export function ActionChain({ text, onSaveAsNew }: { text: string; onSaveAsNew: (content: string) => void }) {
    const { t } = useTranslation();
    const chain = useActionChainStore((s) => s.chain);
    const templates = useActionChainStore((s) => s.templates);
    const { add, removeAt, clear, move, setParam, saveTemplate, applyTemplate, removeTemplate } = useActionChainStore.getState();

    const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
    const [templateAnchor, setTemplateAnchor] = useState<HTMLElement | null>(null);
    const [naming, setNaming] = useState(false);
    const [templateName, setTemplateName] = useState('');
    const [result, setResult] = useState<{ steps: Array<{ id: string; params?: Record<string, string>; action?: unknown; input?: string; output?: string; html?: string; error?: string }>; output: string; error: string }>({ steps: [], output: '', error: '' });

    const seqRef = useRef(0);
    useEffect(() => {
        const seq = ++seqRef.current;
        let cancelled = false;
        void (async () => {
            const next = await runChain(text, chain, { t });
            if (!cancelled && seq === seqRef.current) {
                setResult(next as never);
            }
        })();
        return () => { cancelled = true; };
    }, [text, chain, t]);

    const steps = selectChainSteps(chain);
    const isEmptyChain = chain.length === 0;
    const hasError = Boolean(result.error);

    const lastStep = result.steps[result.steps.length - 1];
    const renderedHtml = lastStep?.html
        ? lastStep.html
        : ((lastStep?.action as { render?: string } | undefined)?.render === 'html' ? lastStep?.output : '');
    const displayText = isEmptyChain ? text : hasError ? '' : result.output;

    const paramValue = (step: typeof steps[number], p: { key: string; type?: string; options?: Array<{ value: string }> }) => {
        const raw = step.params?.[p.key];
        if (raw !== undefined && raw !== '') return String(raw);
        if (p.type === 'select' && p.options?.length) return p.options[0].value;
        return '';
    };

    const visibleParams = (step: typeof steps[number]) => {
        const all = (step.action as { params?: Array<{ key: string; type?: string; options?: Array<{ value: string }>; visibleWhen?: { key: string; equals: string } }> } | undefined)?.params || [];
        return all.filter((p) => {
            if (!p.visibleWhen) return true;
            const dep = all.find((x) => x.key === p.visibleWhen!.key);
            const current = dep ? paramValue(step, dep) : String(step.params?.[p.visibleWhen.key] ?? '');
            return current === p.visibleWhen.equals;
        });
    };

    const stepDelta = (step?: { input?: string; output?: string }) => {
        if (!step) return '';
        return `${Array.from(step.input || '').length} → ${Array.from(step.output || '').length}`;
    };

    const copyResult = async () => {
        try {
            await copyTextToClipboard(displayText);
            toast(t('copySuccess'));
        } catch {
            toast(t('copyFailedGeneral'));
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
            <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.04em', opacity: 0.75 }}>{t('actionChainTitle')}</Typography>
                <span style={{ flex: 1 }} />
                {chain.length > 0 && (
                    <Button size="small" variant="text" onClick={clear}>{t('actionChainClear')}</Button>
                )}
            </Stack>

            <Stack spacing={0.5}>
                {isEmptyChain && <Typography variant="caption" sx={{ opacity: 0.7, py: 1 }}>{t('actionChainEmptyHint')}</Typography>}
                {steps.map((step, index) => (
                    <Box key={`${step.id}-${index}`}>
                        <Stack
                            direction="row"
                            alignItems="center"
                            spacing={0.75}
                            sx={{ px: 1, py: 0.625, border: 1, borderColor: 'divider', borderRadius: 1 }}
                        >
                            <Box sx={{ width: 16, height: 16, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 0.75, background: 'linear-gradient(135deg,#0ea5e9,#14b8a6)', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                                {index + 1}
                            </Box>
                            <MdiIcon name={(step.action as { icon: string }).icon} size={14} />
                            <Typography variant="caption" sx={{ flex: 1, minWidth: 0 }} noWrap>{t((step.action as { nameKey: string }).nameKey)}</Typography>
                            <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.7 }}>{stepDelta(result.steps[index])}</Typography>
                            <Stack direction="row" spacing={0}>
                                <IconButton size="small" disabled={index === 0} onClick={() => move(index, -1)} title={t('actionChainMoveUp')}>
                                    <MdiIcon name="mdi-arrow-up" size={12} />
                                </IconButton>
                                <IconButton size="small" disabled={index === steps.length - 1} onClick={() => move(index, 1)} title={t('actionChainMoveDown')}>
                                    <MdiIcon name="mdi-arrow-down" size={12} />
                                </IconButton>
                                <IconButton size="small" color="error" onClick={() => removeAt(index)} title={t('delete')}>
                                    <MdiIcon name="mdi-close" size={12} />
                                </IconButton>
                            </Stack>
                        </Stack>

                        {visibleParams(step).length > 0 && (
                            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', px: 1, pt: 0.5, pl: 3.75 }}>
                                {visibleParams(step).map((p) => (
                                    <Stack key={p.key} direction="row" alignItems="center" spacing={0.5} sx={{ flex: '1 1 130px', minWidth: 0 }}>
                                        <Typography variant="caption" sx={{ opacity: 0.7, flex: '0 0 auto' }}>{t((p as unknown as { labelKey: string }).labelKey)}</Typography>
                                        {p.type === 'select' ? (
                                            <TextField
                                                select
                                                size="small"
                                                value={paramValue(step, p)}
                                                onChange={(e) => setParam(index, p.key, e.target.value)}
                                                sx={{ flex: 1 }}
                                            >
                                                {(p.options || []).map((o) => (
                                                    <option key={o.value} value={o.value}>{o.value}</option>
                                                ))}
                                            </TextField>
                                        ) : (
                                            <TextField size="small" value={paramValue(step, p)} onChange={(e) => setParam(index, p.key, e.target.value)} sx={{ flex: 1 }} />
                                        )}
                                    </Stack>
                                ))}
                            </Stack>
                        )}
                    </Box>
                ))}
            </Stack>

            <Box sx={{ mt: 1 }}>
                <Button size="small" variant="outlined" fullWidth startIcon={<MdiIcon name="mdi-plus" size={16} />} onClick={(e) => setPickerAnchor(e.currentTarget)}>
                    {t('actionChainAdd')}
                </Button>
                <Menu anchorEl={pickerAnchor} open={Boolean(pickerAnchor)} onClose={() => setPickerAnchor(null)}>
                    <Box sx={{ width: 340, maxHeight: 320, p: 1.25, overflow: 'hidden' }}>
                        <ActionPicker text={text} onPick={(id) => add(id)} />
                    </Box>
                </Menu>
            </Box>

            <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
                <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-bookmark-outline" size={14} />} disabled={!templates.length} onClick={(e) => setTemplateAnchor(e.currentTarget)}>
                    {t('actionTemplateApply')}
                </Button>
                <Menu anchorEl={templateAnchor} open={Boolean(templateAnchor)} onClose={() => setTemplateAnchor(null)}>
                    {templates.map((tpl) => (
                        <Box key={tpl.id} sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.5 }}>
                            <Typography variant="body2" sx={{ flex: 1 }} onClick={() => { applyTemplate(tpl.id); setTemplateAnchor(null); }}>
                                {tpl.name}
                            </Typography>
                            <IconButton size="small" onClick={() => removeTemplate(tpl.id)} aria-label={t('delete')}>
                                <MdiIcon name="mdi-close" size={14} />
                            </IconButton>
                        </Box>
                    ))}
                </Menu>
                <Button size="small" variant="text" startIcon={<MdiIcon name="mdi-content-save-outline" size={14} />} disabled={!chain.length} onClick={() => setNaming((v) => !v)}>
                    {t('actionTemplateSave')}
                </Button>
            </Stack>

            {naming && (
                <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }}>
                    <TextField
                        size="small"
                        fullWidth
                        value={templateName}
                        placeholder={t('actionTemplateNamePlaceholder')}
                        onChange={(e) => setTemplateName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                if (saveTemplate(templateName)) { setNaming(false); setTemplateName(''); toast(t('actionTemplateSaved')); }
                            }
                        }}
                    />
                    <Button
                        size="small"
                        variant="outlined"
                        disabled={!templateName.trim()}
                        onClick={() => {
                            if (saveTemplate(templateName)) { setNaming(false); setTemplateName(''); toast(t('actionTemplateSaved')); }
                        }}
                    >
                        {t('confirm')}
                    </Button>
                </Stack>
            )}

            <Divider sx={{ my: 1.5 }} />

            <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.75 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: '0.04em', opacity: 0.75 }}>{t('actionResultTitle')}</Typography>
                <span style={{ flex: 1 }} />
                {!hasError && (
                    <Button size="small" variant="text" disabled={!displayText} onClick={copyResult}>{t('copyText')}</Button>
                )}
                {!hasError && !isEmptyChain && (
                    <Button size="small" variant="text" onClick={() => onSaveAsNew(displayText)}>{t('actionSaveAsNew')}</Button>
                )}
            </Stack>

            <Box sx={{ minHeight: 140, border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.25 }}>
                {hasError ? (
                    <Stack direction="row" spacing={0.75} alignItems="flex-start">
                        <MdiIcon name="mdi-alert-circle-outline" size={16} color="var(--mui-palette-error-main)" />
                        <Typography variant="caption" color="error">{result.error}</Typography>
                    </Stack>
                ) : renderedHtml ? (
                    <div style={{ fontSize: '0.8125rem', lineHeight: 1.7, wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                ) : displayText ? (
                    <pre style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.75rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {displayText}
                    </pre>
                ) : (
                    <Typography variant="caption" sx={{ opacity: 0.7 }}>{t('actionResultEmpty')}</Typography>
                )}
            </Box>
        </Box>
    );
}
