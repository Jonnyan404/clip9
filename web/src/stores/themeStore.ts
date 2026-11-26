import { create } from 'zustand';

/**
 * 主题主色（明/暗各一份）。
 *
 * ⚠️★ 为什么要单独一个 store：Vue 版是直接改 `theme.themes.value.dark.colors.primary`
 * （Vuetify 的主题是可变对象）。MUI 的 theme 是**不可变**的 —— 要动态换主色就得让
 * `<ThemeProvider>` 拿到一个新的 theme 对象，所以把主色提到 store 里、由 App 用
 * `useMemo` 重建 theme。
 *
 * ⚠️★ **明暗各存一份是故意的**（不是 bug）：同一个色在西红柿色纸上是「胭脂」，
 *    在深色底上往往需要另一支更亮的颜色才看得清。设置里改的永远是**当前明暗**那一份 ——
 *    所以切到另一个模式颜色不变是预期行为，界面上必须把这件事说出来（见传统色对话框的作用域提示）。
 */

/**
 * 默认主色。
 *
 * ⚠️★ 2026-11-26 从 `#1e88e5` 改成 `#1976d2`：前者上的**白字只有 3.68:1** ——
 *    而主色最常干的活就是「实心按钮 + 白字」（发送键、今天 chip、便签贴）。
 *    压深一档到 `#1976d2` 之后白字是 **4.60:1**，颜色还是那个蓝，改动只是一行。
 *    ⚠️ 只影响**没设置过主色**的用户；老用户 localStorage 里那份不动。
 */
export const DEFAULT_PRIMARY = '#1976d2';

const LIGHT_KEY = 'lightPrimary';
const DARK_KEY = 'darkPrimary';

const read = (key: string): string => {
    try {
        return localStorage.getItem(key) || DEFAULT_PRIMARY;
    } catch {
        // 无痕模式 / 存储被禁：退回默认色，别让整个应用起不来
        return DEFAULT_PRIMARY;
    }
};

const write = (key: string, hex: string): void => {
    try {
        localStorage.setItem(key, hex);
    } catch {
        // 存不进去只影响「下次打开还在不在」，当前这次仍然生效
    }
};

interface ThemeState {
    primaryLight: string;
    primaryDark: string;
    setPrimary: (scope: 'light' | 'dark', hex: string) => void;
    /** 把同一个颜色同时写进两套（色板上那个「两套都用」的按钮）。 */
    setPrimaryBoth: (hex: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
    primaryLight: read(LIGHT_KEY),
    primaryDark: read(DARK_KEY),

    setPrimary: (scope, hex) => {
        write(scope === 'dark' ? DARK_KEY : LIGHT_KEY, hex);
        set(scope === 'dark' ? { primaryDark: hex } : { primaryLight: hex });
    },

    setPrimaryBoth: (hex) => {
        write(LIGHT_KEY, hex);
        write(DARK_KEY, hex);
        set({ primaryLight: hex, primaryDark: hex });
    },
}));

/**
 * 跨标签页同步。
 *
 * ⚠️★ 为什么要它：主色存在 `localStorage`，而 `storage` 事件**只发给别的标签页** ——
 *    不监听的话，「在 A 标签页换了个色，B 标签页还是旧的」会一直存在；
 *    用户回来点 B 那页的按钮，看到的是上一套配色，很容易以为是「设置没保存」。
 * ⚠️ 监听器挂在模块级、只挂一次（不是每个组件一个）：
 *    这个事件是全局的，组件级挂会随挂载次数线性增长，且卸载时容易漏摘。
 * ⚠️ 这里**不会**造成回环：`storage` 事件不会回传给触发它的那个页面。
 */
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        // `event.key === null` 表示 `localStorage.clear()` —— 那也该跟着回默认色
        if (event.key !== null && event.key !== LIGHT_KEY && event.key !== DARK_KEY) {
            return;
        }
        useThemeStore.setState({
            primaryLight: read(LIGHT_KEY),
            primaryDark: read(DARK_KEY),
        });
    });
}
