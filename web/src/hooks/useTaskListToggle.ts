import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { toast } from '@/stores/toastStore';
import { decodeHtmlEntities, toggleTaskListItem } from '@/lib/util';
import { updateTextEntry } from '@/services/share';
import type { ReceivedItem } from '@/stores/appStore';

/**
 * 一条文本条目的「任务列表可打勾」状态 —— 从 web-vue3/src/composables/useTaskListToggle.js 移植。
 *
 * 三件事：本地正文（打勾改的是它）、点击处理（挂到渲染 markdown 的容器上）、落盘（防抖）。
 * 界面立刻变（乐观更新），请求防抖 700ms：连点几个框只发一次。
 * **失败就退回上次保存成功的那一版并提示** —— 显示着「已勾」却没存上是更糟的谎。
 *
 * ⚠️ 复制文本也要用这里返回的 `text`（用户看到什么就复制什么）。
 * ⚠️ 这个 hook 是**按条目**的（各自持 ref 与计时器）—— 必须在**每个列表项一个组件实例**里调，
 *    不能在列表容器里调（否则所有卡片共用一个状态与一个计时器）。
 */
export function useTaskListToggle(meta: ReceivedItem | undefined, getRoom: () => string) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => decodeHtmlEntities(String(meta?.content || '')));
    const textRef = useRef(text);
    const savedRef = useRef(text);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        textRef.current = text;
    }, [text]);

    // 条目换了就重置（React 侧通常靠 `key` 重新挂载，这里兜一层）。
    useEffect(() => {
        const next = decodeHtmlEntities(String(meta?.content || ''));
        setText(next);
        textRef.current = next;
        savedRef.current = next;
    }, [meta?.id]);

    const persist = useCallback(async () => {
        const next = textRef.current;
        if (next === savedRef.current) return;
        try {
            await updateTextEntry(String(meta?.id ?? ''), getRoom(), next);
            savedRef.current = next;
        } catch (error) {
            console.error('保存任务列表失败:', error);
            toast(t('taskSaveFailed'));
            setText(savedRef.current);
        }
    }, [meta?.id, getRoom, t]);

    const flip = useCallback((index: number) => {
        setText((prev) => toggleTaskListItem(prev, index));
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
            void persist();
        }, 700);
    }, [persist]);

    // 只接复选框的点击，别的点击原样放过（容器上还有别的行为）。
    const onMdClick = useCallback((e: ReactMouseEvent<HTMLElement>) => {
        const box = e.target as HTMLElement | null;
        if (!box || box.tagName !== 'INPUT' || (box as HTMLInputElement).type !== 'checkbox') return;
        const boxes = Array.from(e.currentTarget.querySelectorAll('input[type=checkbox]'));
        const index = boxes.indexOf(box as HTMLInputElement);
        if (index < 0) return;
        // 拦掉浏览器自己翻转：状态以源码为准，翻转后由重新渲染出来
        e.preventDefault();
        // ⚠️ 还要拦住冒泡：便签卡片整块是「点开阅读器」，不拦的话一勾就把大视图打开了
        e.stopPropagation();
        flip(index);
    }, [flip]);

    useEffect(() => () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
    }, []);

    return { text, onMdClick };
}
