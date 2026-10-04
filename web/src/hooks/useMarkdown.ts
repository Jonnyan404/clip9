import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectDisplay, useAppStore } from '@/stores/appStore';
import { findAction, renderFenced, runChain, targetedActions } from '@/lib/actions/index.js';
import { prefersRenderedView } from '@/lib/util';

/**
 * 一条内容的显示方式 —— **动作库驱动**。从 web-vue3/src/composables/useMarkdown.js 移植。
 *
 * 两层职责分得很清楚（别合并）：
 *   · 个性化里的开关（`display.markdown`，面板上叫「动作图标」）—— 只决定**要不要显示那些图标**；
 *   · 右上角那几个图标 —— 决定**这一条用哪种方式看**。
 *
 * ⚠️ 「原文」不是动作（它不跑任何东西），所以用 `null` 表示。
 * ⚠️ 任务列表和表格**默认就是 md**（`prefersRenderedView`）；其余内容默认看原文。
 *
 * @param getText         取原始文本
 * @param isMarkdownFile  可选：扩展名是 .md 这类可靠信号（文件预览的正文是截断过的，启发式可能判不出来）
 */
export interface MarkdownAction {
    id: string;
    nameKey: string;
    icon: string;
    render?: string;
    fenceLanguage?: string;
}

export interface UseMarkdownResult {
    available: boolean;
    actions: MarkdownAction[];
    copyText: string;
    gutter: string;
    html: string;
    leadsWithBlock: boolean;
    mode: string | null;
    setMode: (next: string | null) => void;
}

export function useMarkdown(
    getText: () => string,
    isMarkdownFile: () => boolean = () => false,
): UseMarkdownResult {
    const markdownEnabled = useAppStore((s) => Boolean(selectDisplay(s).markdown));
    const { t } = useTranslation();

    const text = getText();
    const mdFile = isMarkdownFile();

    // 这条内容能用哪些**有针对性**的动作（声明了 match 且命中），按注册顺序。
    const targeted = useMemo<MarkdownAction[]>(() => {
        const list = targetedActions(text) as MarkdownAction[];
        if (mdFile && !list.some((action) => action.id === 'format.markdown')) {
            const markdownAction = findAction('format.markdown') as MarkdownAction | undefined;
            if (markdownAction) {
                return [markdownAction, ...list];
            }
        }
        return list;
    }, [text, mdFile]);

    // 用户显式选过的动作 id。`undefined` = 从没选过（跟随默认值），`null` = 明确要看原文。
    const [override, setOverride] = useState<string | null | undefined>(undefined);

    // 默认值**跟着内容走**，不能只在挂载时定一次（文件预览的正文是异步抓回来的）。
    const defaultId = prefersRenderedView(text) ? 'format.markdown' : null;
    const mode = override === undefined ? defaultId : override;

    // 图标排显示的条件：开关开着 + 至少有一个**针对性**动作。
    // ⚠️ 通用动作（转大写、Base64 编码…）**不单独触发显示** —— 否则每条普通文本上都会挂一排图标。
    const available = markdownEnabled && targeted.length > 0;

    // 当前视图的渲染结果。**是异步的**：format.code 要 await 语言检测。
    const [html, setHtml] = useState('');
    const [viewText, setViewText] = useState('');
    const seqRef = useRef(0);

    useEffect(() => {
        const seq = ++seqRef.current;
        if (!available || !mode) {
            setHtml('');
            setViewText('');
            return;
        }
        let cancelled = false;
        void (async () => {
            // `truncated` 告诉动作「这条正文是截断过的」—— 目前只有 markdown 那个动作在意它。
            const result = await runChain(text, [mode], { t, truncated: mdFile });
            // 防竞态：快速切视图时，先发起的计算可能后回来
            if (cancelled || seq !== seqRef.current) {
                return;
            }
            if (result.error) {
                // 跑不出来就当没有这个视图、退回原文 —— 卡片预览区不该弹错误（报错是工作台的活）
                setHtml('');
                setViewText('');
                return;
            }
            const action = findAction(mode) as MarkdownAction | undefined;
            const last = result.steps[result.steps.length - 1];
            if (last?.html) {
                setHtml(last.html);
                setViewText(result.output);
                return;
            }
            if (action?.render === 'html') {
                setHtml(result.output);
                setViewText('');
                return;
            }
            setHtml(renderFenced(result.output, action?.fenceLanguage || ''));
            setViewText(result.output);
        })();
        return () => {
            cancelled = true;
        };
    }, [text, mode, available, mdFile, t]);

    // 渲染结果是不是以 `<pre>` 开头（代码视图 / JSON / 编解码结果都是）——
    // 消费方据此**关掉浮动占位**（`<pre>` 带 overflow-x，是 BFC，不会绕着浮动块排版）。
    const leadsWithBlock = /^\s*<pre[\s>]/.test(html || '');

    // 「复制」该复制**你正在看的那一份**：原文 / 当前动作的结果。
    const copyText = viewText || text;

    // 图标有几个 → 正文要给图标让出多宽。总数封在 3 个（原文 + 2 个针对性动作 + ⋯）。
    const iconCount = !available ? 0 : 1 + Math.min(targeted.length, 2) + (targeted.length > 2 ? 1 : 0);
    const gutter = iconCount > 2 ? '96px' : '64px';

    const setMode = useCallback((next: string | null) => {
        setOverride(next ?? null);
    }, []);

    return {
        available,
        actions: targeted,
        copyText,
        gutter,
        html,
        leadsWithBlock,
        mode,
        setMode,
    };
}
