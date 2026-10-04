import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';
import zhTW from './locales/zh-TW.json';
import ja from './locales/ja.json';

// 从 web-vue3/src/vue-i18n.js 移植。语言探测与存储键（`locale`）**逐字保留**。
//
// ⚠️★ 插值语法：现有 440 条文案用的是 vue-i18n 的**单花括号** `{count}` / `{name}`。
// i18next 默认前缀是 `{{`，直接搬会导致所有插值原样显示成 `{count}`。
// 这里把 i18next 的插值前缀/后缀改成单花括号，于是**键名与占位符一个字都不用改**。
// ⚠️ 代价与遗留项（Phase 2/3 处理）：vue-i18n 的**复数**用 `key|one|other` 语法，
//    i18next 用 `key_one` / `key_other` 后缀 —— 带 `|` 的键需要逐条转换；
//    含**字面花括号**的文案也要复核（本项目目前没有）。
function getBrowserLocale(): string {
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('zh-tw') || lang.startsWith('zh-hk')) {
        return 'zh-TW';
    }
    if (lang.startsWith('zh')) {
        return 'zh';
    }
    if (lang.startsWith('ja')) {
        return 'ja';
    }
    return 'en';
}

void i18next.use(initReactI18next).init({
    resources: {
        en: { translation: en },
        zh: { translation: zh },
        'zh-TW': { translation: zhTW },
        ja: { translation: ja },
    },
    lng: localStorage.getItem('locale') || getBrowserLocale(),
    fallbackLng: 'en',
    interpolation: {
        prefix: '{',
        suffix: '}',
        escapeValue: false,
    },
    // 资源已随包打进 bundle，不需要异步加载 —— 关掉延迟初始化，首帧就能拿到译文。
    initImmediate: false,
});

export default i18next;
