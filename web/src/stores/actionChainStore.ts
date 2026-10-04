import { create } from 'zustand';
import { findAction, makeStep, stepId, stepParams } from '@/lib/actions/index.js';

/**
 * 动作链 —— 从 web-vue3/src/composables/useActionChain.js 移植。
 *
 * ⚠️ Vue 版是**模块级单例 ref**（「链属于工作台这一个会话状态，各组件读的必须是同一份」）。
 * React 侧等价物就是 Zustand store —— 同样全局一份，不会因为组件重挂载而丢。
 *
 * ⚠️ 执行本身不在这里（见 `lib/actions` 的 `runChain`，纯函数、好测）。这里只管
 * 「链是什么」和「模板怎么存」。
 */

/** 链元素两种形态：裸 id 字符串，或带参数的 `{id, params}`。 */
export type ChainElement = string | { id: string; params?: Record<string, string> };

export interface ActionTemplate {
    id: string;
    name: string;
    steps: ChainElement[];
}

const CHAIN_KEY = 'ccgActionChain';
const TEMPLATES_KEY = 'ccgActionTemplates';

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) {
            return fallback;
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T) : fallback;
    } catch {
        // 隐私模式 / 坏数据：当作没有。链丢了不是错误，不该让页面起不来。
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 存不下就算了，内存里仍然生效 */ }
}

// 只保留还存在的动作 id —— 动作被删掉（或改名）之后，老 localStorage 里会留着孤儿 id。
// ⚠️ 链元素有**两种形态**，所以判存在性必须走 `stepId`，不能拿元素当字符串用。
function sanitize(chain: unknown): ChainElement[] {
    return (Array.isArray(chain) ? chain : []).filter((step) => Boolean(findAction(stepId(step))));
}

function newTemplateId(): string {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
        return `tpl-${crypto.randomUUID()}`;
    }
    return `tpl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface ActionChainState {
    chain: ChainElement[];
    templates: ActionTemplate[];
    add: (id: string) => void;
    removeAt: (index: number) => void;
    clear: () => void;
    move: (index: number, delta: number) => void;
    setParam: (index: number, key: string, value: string) => void;
    setChain: (steps: unknown) => void;
    saveTemplate: (name: string) => ActionTemplate | null;
    applyTemplate: (id: string) => void;
    removeTemplate: (id: string) => void;
}

export const useActionChainStore = create<ActionChainState>((set, get) => ({
    chain: sanitize(readJson<ChainElement[]>(CHAIN_KEY, [])),
    templates: readJson<ActionTemplate[]>(TEMPLATES_KEY, [])
        .filter((tpl) => tpl && typeof tpl.id === 'string')
        .map((tpl) => ({ ...tpl, steps: sanitize(tpl.steps) }))
        .filter((tpl) => tpl.steps.length),

    /**
     * 追加一个动作到链尾。
     * ⚠️ **允许重复**：链是流水线，「Base64 编码」跑两次是合法意图（双重编码）。
     */
    add: (id) => {
        if (findAction(id)) {
            const chain = [...get().chain, id];
            set({ chain });
            writeJson(CHAIN_KEY, chain);
        }
    },
    removeAt: (index) => {
        const chain = get().chain.filter((_, i) => i !== index);
        set({ chain });
        writeJson(CHAIN_KEY, chain);
    },
    clear: () => {
        set({ chain: [] });
        writeJson(CHAIN_KEY, []);
    },
    /** 上移/下移一步。`delta` 为 -1 / +1，越界不动。 */
    move: (index, delta) => {
        const chain = get().chain;
        const target = index + delta;
        if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) {
            return;
        }
        const next = [...chain];
        [next[index], next[target]] = [next[target], next[index]];
        set({ chain: next });
        writeJson(CHAIN_KEY, next);
    },
    /**
     * 改链上某一步的参数。
     * ⚠️ 用 **index** 而不是 id 定位：链**允许重复**，按 id 找会改错那一个。
     * ⚠️ 值清空后会自动退回**字符串形态**（见 makeStep）—— 存储里不会留下没意义的空壳。
     */
    setParam: (index, key, value) => {
        const step = get().chain[index];
        if (!step) {
            return;
        }
        const params = { ...stepParams(step), [key]: value };
        const next = [...get().chain];
        next[index] = makeStep(stepId(step), params) as ChainElement;
        set({ chain: next });
        writeJson(CHAIN_KEY, next);
    },
    setChain: (steps) => {
        const chain = sanitize(steps);
        set({ chain });
        writeJson(CHAIN_KEY, chain);
    },

    // ── 模板 ──
    /** 把当前链存成一个命名模板。链为空时不存。 */
    saveTemplate: (name) => {
        const label = String(name || '').trim();
        const chain = get().chain;
        if (!label || !chain.length) {
            return null;
        }
        const tpl: ActionTemplate = { id: newTemplateId(), name: label, steps: [...chain] };
        const templates = [...get().templates, tpl];
        set({ templates });
        writeJson(TEMPLATES_KEY, templates);
        return tpl;
    },
    applyTemplate: (id) => {
        const tpl = get().templates.find((t) => t.id === id);
        if (tpl) {
            get().setChain(tpl.steps);
        }
    },
    removeTemplate: (id) => {
        const templates = get().templates.filter((t) => t.id !== id);
        set({ templates });
        writeJson(TEMPLATES_KEY, templates);
    },
}));

/**
 * 把链解析成「每一步：id + 参数 + 动作定义」—— 对应 Vue 版的 `steps` computed。
 *
 * ⚠️ params 从**链元素**里读，不从 action 上读 —— 同一个动作可以在链上出现两次、
 * 两次用不同参数，所以参数属于「这一步」而不是「这个动作」。
 */
export function selectChainSteps(chain: ChainElement[]) {
    return chain
        .map((step) => ({ id: stepId(step), params: stepParams(step), action: findAction(stepId(step)) }))
        .filter((s) => s.action);
}
