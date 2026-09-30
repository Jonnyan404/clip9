import { createApp } from 'vue';
// 代码高亮的令牌配色：全局一份（CodeBlock 与 MarkdownBody 共用，见文件头注释）
import './styles/highlight.css';
import axios from 'axios';
import App from './App.vue';
import router from './router';
import vuetify from './plugins/vuetify';
import i18n from './vue-i18n';
import pinia from './store';
import { APP_BASE_URL } from './base.js';
import { setupAxiosInterceptors } from './store/interop';
import { useWebSocketStore } from './store/websocket';
import { useAppStore } from './store/app';
import { setupServiceWorkerUpdate } from './sw-update.js';
import { installShareBridge } from './share.js';
import { readLocationParam } from './util.js';

// 全部接口调用都用**相对路径**（`share`、`content/7`…），而 history 模式下文档目录不再是
// `<prefix>/`：分享页的地址是 `<prefix>/s/<token>`，相对路径会被解析成 `<prefix>/s/share`。
// 统一给 axios 一个绝对 baseURL（= 外壳的基准目录，也就是 `<prefix>/`），
// 这个约定与「相对路径不带前导斜杠」配套 —— 带前导斜杠的调用会绕过 baseURL（本仓库没有那种写法）。
axios.defaults.baseURL = APP_BASE_URL;

setupAxiosInterceptors();

const app = createApp(App);

app.use(pinia);

// SW 更新检测在 pinia 之后装：它要读「有没有还没发出去的内容」来决定现在刷还是等会刷
// （手机 PWA 上用户永远不会手动强刷，见 sw-update.js）。
setupServiceWorkerUpdate();

const appStore = useAppStore();
const wsStore = useWebSocketStore();

// 深浅色（2026-09-29）：嵌入态（桌面端 iframe，`?embed=1`）会带 `?theme=dark|light`，
// 把**桌面端选的主题**同步进来 —— Jonny：「桌面客户端的深浅主题切换同步到网页端」。
// ⚠️ 只在 embed 下生效：普通浏览器访问不该被一个 URL 参数改掉自己的偏好；
// ⚠️ 嵌入下 SPA 自己那颗深浅开关仍能切（`app.dark` 照常赋值），只是**下一次加载**
//    又会被桌面端带过来的值盖回去 —— 这是同步的代价，说清了再谈要不要改。
//
// ⚠️★ **必须赶在 `app.mount()` 之前**（原来它写在下面 `router.isReady()` 的回调里）：
//   store 的初值是 `dark: null` → 解析成「浅色」，而 `App.vue` 的
//   `onMounted(() => applyDarkMode())` 是在 `mount()` 里跑的 —— 回调那时还没执行，
//   于是**每一帧都先画浅色、再切深色**。表现就是「打开闪一下白」；
//   桌面端切一次主题 = 重载一次 iframe = 闪一次。实测症状见 `desktop-client.md`。
//   ⚠️ 它**不依赖路由**（`readLocationParam` 只读 `window.location.search`），
//   挪上来没有副作用；留在下面则是「等一个不需要等的 promise」。
const themeParam = readLocationParam('theme');
const forcedTheme = readLocationParam('embed') === '1'
    ? (themeParam === 'dark' ? 'enable' : themeParam === 'light' ? 'disable' : '')
    : '';
appStore.dark = forcedTheme || localStorage.getItem('darkmode') || 'prefer';

app.use(router);
app.use(vuetify);
app.use(i18n);

// 外壳入口（分享菜单）：`window.clip9Share`，契约见 share.js 抬头与
// `dev-docs/specs/android-client.md` §4。
// ⚠️ 位置有讲究：必须在 pinia 装好之后（里面要读 store），也必须在 `mount` 之前 ——
// 外壳是「页面加载完就调」，晚一步那次分享就落在空的 window 上。
// ⚠️ 分享页也照挂（那边 room 为空 → 老实回 `no-room`），理由见 share.js。
installShareBridge();

router.isReady().then(() => {
    // ⚠️ 深浅色**不在这里** —— 它移到了上面 `app.mount()` 之前（理由见那一段：
    // 写在这里会晚于首次绘制，闪一帧浅色）。
    // 分享页是给收件人看的独立页面：不建 WebSocket、不碰房间状态。
    // 它只认 URL 里的 token，走自己那几个相对路径请求（见 views/ShareView.vue）。
    if (router.currentRoute.value.meta?.sharePage) {
        return;
    }
    wsStore.initFromRoute(router.currentRoute.value.query.room || '');
    wsStore.connect();
});

app.mount('#app');
