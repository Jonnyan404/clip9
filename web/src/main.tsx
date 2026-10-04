import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';

// 图标字体（MDI）：数据层（catalog.json / displayToggles / registry）里存的是
// `mdi-brightness-4` 这类**类名**，靠这套 CSS 字体渲染 —— 保留 `@mdi/font` 可让数据层零改动。
import '@mdi/font/css/materialdesignicons.css';
import './styles/highlight.css';
import './styles/global.css';

import { APP_BASE_URL } from '@/lib/base';
// i18n 实例必须在使用 `useTranslation` 的组件渲染之前初始化。
// 资源随包打进 bundle + `initImmediate: false`，所以它是**同步**完成的。
import '@/i18n';

import { App } from './App';

// ⚠️★ 全部接口调用都用**相对路径**（`share`、`content/7`…），而 history 模式下文档目录不再是
// `<prefix>/`：分享页的地址是 `<prefix>/s/<token>`，相对路径会被解析成 `<prefix>/s/share`。
// 统一给 axios 一个绝对 baseURL（= 外壳的基准目录），这个约定与「相对路径不带前导斜杠」配套
// —— 带前导斜杠的调用会绕过 baseURL（本仓库没有那种写法）。
axios.defaults.baseURL = APP_BASE_URL;

// ⚠️ 与 web-vue3/src/main.js 的差异（Phase 2 补齐，见 react-migration-plan.md §5.3）：
//   · setupAxiosInterceptors()  —— 请求补 token / 401 → 鉴权弹窗；
//   · 主题解析（`?theme=` / localStorage / embed）必须在**首次渲染之前**定下来（防闪白）；
//   · installShareBridge() / installHostBridge() / setupServiceWorkerUpdate()；
//   · wsStore.connect()（在路由就绪、且**不是**分享页时）。

createRoot(document.getElementById('app')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
