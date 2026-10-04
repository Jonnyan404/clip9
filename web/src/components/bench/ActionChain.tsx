import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Divider, Menu, MenuItem, Popover, TextField } from '@mui/material';
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
 * ⚠️★ 样式全部走 `.action-chain*`（styles/components.css），与 Vue 同名同值。
 *    尤其**参数输入框是原生 `input` / `select`**，不是 MUI 的 TextField ——
 *    TextField 自带的 padding/margin 会把每一步撑高一大截，紧凑列表就散了。
 */
interface SelectOption {
    value: string;
    /** ⚠️★ 选项的**显示名**走这个键，别拿 `value` 当文案 —— `value` 是 `text`/`digits`
     *  这类机器值，直接渲染出来就是一句英文（用户报的「查找模式还是英文」）。 */
    labelKey?: string;
}

interface ParamSpec {
    key: string;
    labelKey?: string;
    type?: string;
    options?: SelectOption[];
    visibleWhen?: { key: string; equals: string };
}

interface StepAction {
    icon: string;
    nameKey: string;
    params?: ParamSpec[];
    render?: string;
}

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

    const paramValue = (step: typeof steps[number], p: ParamSpec) => {
        const raw = step.params?.[p.key];
        if (raw !== undefined && raw !== '') return String(raw);
        if (p.type === 'select' && p.options?.length) return p.options[0].value;
        return '';
    };

    const visibleParams = (step: typeof steps[number]): ParamSpec[] => {
        const all = (step.action as StepAction | undefined)?.params || [];
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

    const confirmSaveTemplate = () => {
        if (saveTemplate(templateName)) {
            setNaming(false);
            setTemplateName('');
            toast(t('actionTemplateSaved'));
        }
    };

    return (
        <div className="action-chain">
            <div className="action-chain__head">
                <span className="action-chain__title">{t('actionChainTitle')}</span>
                <span style={{ flex: 1 }} />
                {chain.length > 0 && (
                    <Button size="small" variant="text" onClick={clear}>{t('actionChainClear')}</Button>
                )}
            </div>

            <div className="action-chain__steps">
                {isEmptyChain && <div className="action-chain__hint">{t('actionChainEmptyHint')}</div>}
                {steps.map((step, index) => {
                    const action = step.action as StepAction;
                    return (
                        <div key={`${step.id}-${index}`}>
                            <div className="action-chain__step">
                                <span className="action-chain__step-n">{index + 1}</span>
                                <MdiIcon name={action.icon} size={14} />
                                <span className="action-chain__step-name">{t(action.nameKey)}</span>
                                <span className="action-chain__step-delta">{stepDelta(result.steps[index])}</span>
                                <span className="action-chain__step-actions">
                                    <button
                                        type="button"
                                        className="action-chain__mini"
                                        disabled={index === 0}
                                        title={t('actionChainMoveUp')}
                                        onClick={() => move(index, -1)}
                                    >
                                        <MdiIcon name="mdi-arrow-up" size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        className="action-chain__mini"
                                        disabled={index === steps.length - 1}
                                        title={t('actionChainMoveDown')}
                                        onClick={() => move(index, 1)}
                                    >
                                        <MdiIcon name="mdi-arrow-down" size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        className="action-chain__mini action-chain__mini--danger"
                                        title={t('delete')}
                                        onClick={() => removeAt(index)}
                                    >
                                        <MdiIcon name="mdi-close" size={12} />
                                    </button>
                                </span>
                            </div>

                            {/* 带参数的动作：输入框**内联在步骤下面**，不弹窗 ——
                                参数是「这一步」的一部分（同一个动作可以在链上出现两次、用不同参数），
                                弹窗会让人分不清正在改哪一步。 */}
                            {visibleParams(step).length > 0 && (
                                <div className="action-chain__params">
                                    {visibleParams(step).map((p) => (
                                        <label key={p.key} className="action-chain__param">
                                            <span className="action-chain__param-label">{t(p.labelKey || '')}</span>
                                            {p.type === 'select' ? (
                                                <select
                                                    className="action-chain__param-input"
                                                    value={paramValue(step, p)}
                                                    onChange={(e) => setParam(index, p.key, e.target.value)}
                                                >
                                                    {(p.options || []).map((o) => (
                                                        // ⚠️★ 显示的是 `t(labelKey)`，**不是** `o.value`
                                                        //（value 是机器值，直接显示就是英文）。
                                                        <option key={o.value} value={o.value}>{t(o.labelKey || o.value)}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <input
                                                    type="text"
                                                    className="action-chain__param-input"
                                                    value={paramValue(step, p)}
                                                    onChange={(e) => setParam(index, p.key, e.target.value)}
                                                />
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="action-chain__add">
                <button
                    type="button"
                    className="action-chain__add-btn"
                    onClick={(e) => setPickerAnchor(e.currentTarget as unknown as HTMLElement)}
                >
                    <MdiIcon name="mdi-plus" size={16} />
                    {t('actionChainAdd')}
                </button>
                {/* ⚠️★ 用 **Popover** 而不是 Menu：Menu 会把子节点包进 MenuList
                    （自带 8px 上下内边距），而这里要的是一个「面板」，不是一串菜单项
                    —— Vue 的 v-menu 内容就是那个 div 本身。
                    ⚠️ 选完**不关**（`onPick` 里不 setAnchor）：连着叠三步不该每次重新打开。
                    点外面才关 —— 这正是 Popover 的行为，对应 Vue 的
                    `:close-on-content-click="false"`。 */}
                <Popover
                    open={Boolean(pickerAnchor)}
                    anchorEl={pickerAnchor}
                    onClose={() => setPickerAnchor(null)}
                    anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                    transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                    slotProps={{ paper: { sx: { mt: 0.75, overflow: 'visible' } } }}
                >
                    <div className="action-chain__picker">
                        <ActionPicker text={text} onPick={(id) => add(id)} />
                    </div>
                </Popover>
            </div>

            <div className="action-chain__templates">
                <Button
                    size="small"
                    variant="text"
                    startIcon={<MdiIcon name="mdi-bookmark-outline" size={14} />}
                    disabled={!templates.length}
                    onClick={(e) => setTemplateAnchor(e.currentTarget)}
                >
                    {t('actionTemplateApply')}
                </Button>
                <Menu anchorEl={templateAnchor} open={Boolean(templateAnchor)} onClose={() => setTemplateAnchor(null)}>
                    {templates.map((tpl) => (
                        <MenuItem
                            key={tpl.id}
                            onClick={() => { applyTemplate(tpl.id); setTemplateAnchor(null); }}
                            sx={{ gap: 1.5 }}
                        >
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                                <div>{tpl.name}</div>
                                <div style={{ fontSize: '0.6875rem', opacity: 0.7 }}>
                                    {tpl.steps.length} {t('actionChainSteps')}
                                </div>
                            </Box>
                            <Button
                                size="small"
                                variant="text"
                                aria-label={t('delete')}
                                onClick={(e) => { e.stopPropagation(); removeTemplate(tpl.id); }}
                            >
                                <MdiIcon name="mdi-close" size={14} />
                            </Button>
                        </MenuItem>
                    ))}
                </Menu>
                <Button
                    size="small"
                    variant="text"
                    startIcon={<MdiIcon name="mdi-content-save-outline" size={14} />}
                    disabled={!chain.length}
                    onClick={() => setNaming((v) => !v)}
                >
                    {t('actionTemplateSave')}
                </Button>
            </div>

            {naming && (
                <div className="action-chain__naming">
                    <TextField
                        size="small"
                        fullWidth
                        value={templateName}
                        placeholder={t('actionTemplateNamePlaceholder')}
                        onChange={(e) => setTemplateName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') confirmSaveTemplate();
                        }}
                    />
                    <Button size="small" variant="contained" disabled={!templateName.trim()} onClick={confirmSaveTemplate}>
                        {t('confirm')}
                    </Button>
                </div>
            )}

            <Divider sx={{ my: 1.5 }} />

            <div className="action-chain__head">
                <span className="action-chain__title">{t('actionResultTitle')}</span>
                <span style={{ flex: 1 }} />
                {!hasError && (
                    <Button size="small" variant="text" disabled={!displayText} onClick={copyResult}>{t('copyText')}</Button>
                )}
                {!hasError && !isEmptyChain && (
                    <Button size="small" variant="text" onClick={() => onSaveAsNew(displayText)}>{t('actionSaveAsNew')}</Button>
                )}
            </div>

            <div className="action-chain__result">
                {hasError ? (
                    <div className="action-chain__error">
                        <MdiIcon name="mdi-alert-circle-outline" size={16} />
                        <span>{result.error}</span>
                    </div>
                ) : renderedHtml ? (
                    <div className="action-chain__html" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                ) : displayText ? (
                    <pre className="action-chain__pre">{displayText}</pre>
                ) : (
                    <div className="action-chain__empty">{t('actionResultEmpty')}</div>
                )}
            </div>
        </div>
    );
}
