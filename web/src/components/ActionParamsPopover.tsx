import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, MenuItem, Popover, TextField, Typography } from '@mui/material';

/**
 * 「这个动作要先填参数」的小表单。
 *
 * 为什么需要它：`text.replace`（查找替换）声明了 `params`，而**预览右上角那排图标**
 * 原来只会喊一句 `onModeChange(id)` —— 动作拿不到参数，`replaceLiteral` 直接抛
 * 「请先填『查找』的内容」，而 `useMarkdown` 把错误咽掉了（它的原则是「卡片预览区不弹错误」）。
 * 于是用户看到的是**点了没反应**。这个表单补的就是那一步。
 *
 * ⚠️★ 只支持 `select` 与文本两种控件 —— 这正是 catalog 里目前出现的全部类型
 *    （`text.replace` 的 mode 是 select，find / with 是文本）。加第三种类型时**先看有几个动作要用**，
 *    别为一个参数造一个控件。
 * ⚠️ 参数值一律当**字符串**传下去：动作的 `params` 是从 DOM 来的，数字/布尔在那边还要再判一次类型，
 *    多一层转换只会多一处不一致。
 */
export interface ParamSpec {
    key: string;
    labelKey: string;
    type?: string;
    required?: boolean;
    options?: Array<{ value: string; labelKey: string }>;
    visibleWhen?: { key: string; equals: string };
}

/** 一个参数的初始值：select 取第一个选项（下拉不能是空的，否则一打开就报"未选择"）。 */
function initialValues(params: ParamSpec[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const param of params) {
        if (param.type === 'select') {
            out[param.key] = param.options?.[0]?.value ?? '';
        } else {
            out[param.key] = '';
        }
    }
    return out;
}

export function ActionParamsPopover({
    open,
    anchorEl,
    actionId,
    actionName,
    params,
    initial,
    onClose,
    onSubmit,
}: {
    open: boolean;
    anchorEl: HTMLElement | null;
    actionId: string;
    actionName: string;
    params: ParamSpec[];
    /** 上一次填过的值（同一个动作再点开时预填，免得重敲一遍查找词）。 */
    initial?: Record<string, string>;
    onClose: () => void;
    onSubmit: (values: Record<string, string>) => void;
}) {
    const { t } = useTranslation();
    const defaults = useMemo(() => initialValues(params), [params]);
    const [values, setValues] = useState<Record<string, string>>({ ...defaults, ...initial });
    const [error, setError] = useState('');

    // ⚠️ 每次打开都重置：弹层是同一个 DOM 节点复用，不重置的话上次那个动作的查找词会跟到这次来。
    useEffect(() => {
        if (open) {
            setValues({ ...defaults, ...initial });
            setError('');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, actionId]);

    // `visibleWhen` 让「文本模式才需要填查找词」这种事由数据决定，而不是组件里写 if。
    const visible = params.filter((param) => {
        if (!param.visibleWhen) {
            return true;
        }
        return String(values[param.visibleWhen.key] ?? '') === param.visibleWhen.equals;
    });

    const submit = () => {
        const missing = visible.find((param) => param.required && !String(values[param.key] ?? '').trim());
        if (missing) {
            setError(t('actionParamRequired', { name: t(missing.labelKey) }));
            return;
        }
        setError('');
        onSubmit(values);
    };

    return (
        <Popover
            open={open}
            anchorEl={anchorEl}
            onClose={onClose}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { sx: { p: 1.5, width: 260, mt: 0.5 } } }}
        >
            <Typography variant="subtitle2" sx={{ mb: 1 }}>{actionName}</Typography>
            {visible.map((param) => (
                param.type === 'select' ? (
                    <TextField
                        key={param.key}
                        select
                        size="small"
                        fullWidth
                        label={t(param.labelKey)}
                        value={values[param.key] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
                        sx={{ mb: 1 }}
                    >
                        {(param.options ?? []).map((option) => (
                            <MenuItem key={option.value} value={option.value}>{t(option.labelKey)}</MenuItem>
                        ))}
                    </TextField>
                ) : (
                    <TextField
                        key={param.key}
                        size="small"
                        fullWidth
                        label={t(param.labelKey)}
                        value={values[param.key] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [param.key]: e.target.value }))}
                        // 回车即提交：这是个只有两三个字段的小表单，再让用户去点一次按钮没必要。
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                        sx={{ mb: 1 }}
                    />
                )
            ))}
            {error && (
                <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
                    {error}
                </Typography>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="small" onClick={onClose}>{t('cancel')}</Button>
                <Button size="small" variant="contained" onClick={submit}>{t('ok')}</Button>
            </div>
        </Popover>
    );
}
