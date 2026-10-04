import { fileURLToPath, URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { VitePWA } from 'vite-plugin-pwa';

// 从 web-vue3/vite.config.js 移植。三件事必须**原样保留**（改错不报错、只静默退化）：
//   1. build id 注入（bundle + `<html data-build-id>` 两处）；
//   2. PWA 的 `navigateFallbackDenylist`（漏一条服务端路由 → SW 导航兜底吞掉点击）；
//   3. dev 下注入 `<base href="/">`（history 深路径 `/s/<token>` 靠它把相对地址拉回根目录）。
// ⚠️ 与 web-vue3 的差异只有插件（@vitejs/plugin-vue → @vitejs/plugin-react-swc）与
//    manualChunks 的分组（vue-core → react-core，vuetify → mui）。
export default defineConfig(({ command }) => {
    // 每次构建生成一个唯一指纹，注入到 bundle 和 <html data-build-id> 两处，用来核对
    // 「线上跑的是哪次构建」。判据用 `command` 而不是 `process.env.NODE_ENV`：开发服务器
    // 下根本没有构建这回事，固定 'dev' 即可。
    const buildId = command === 'build' ? randomBytes(4).toString('hex') : 'dev';

    return {
        plugins: [
            react(),
            // define 只替换 JS 模块；index.html 里的 __BUILD_ID__ 得靠这个钩子。
            // 写到 <html data-build-id> 上，view-source 就能核对线上是哪次构建。
            //
            // dev 下额外注入 `<base href="/">`：history 路由的深路径（`/s/<token>`）靠它把相对
            // 地址（`./assets/…`、以及 axios 的相对接口路径）拉回根目录。dev 没有 prefix，
            // 所以固定 `/` 就是对的；线上这一份由服务端注入，带真实 prefix（见 lib/spa_shell.rs）。
            {
                name: 'inject-build-id-into-html',
                transformIndexHtml(html: string) {
                    const withBuildId = html.replaceAll('__BUILD_ID__', buildId);
                    if (command !== 'build') {
                        return withBuildId.replace('<head>', '<head>\n    <base href="/">');
                    }
                    return withBuildId;
                },
            },
            VitePWA({
                registerType: 'autoUpdate',
                injectRegister: null,
                includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'reward-wechat.png', 'reward-alipay.png'],
                manifest: {
                    name: 'clip9',
                    short_name: 'clip9',
                    description: 'Browser-based cloud clipboard for text and files',
                    lang: 'zh',
                    start_url: './',
                    scope: './',
                    display: 'standalone',
                    orientation: 'any',
                    background_color: '#1e88e5',
                    theme_color: '#1e88e5',
                    icons: [
                        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
                        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
                        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                    ],
                },
                workbox: {
                    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,woff,ttf,eot}'],
                    cleanupOutdatedCaches: true,
                    navigateFallback: 'index.html',
                    // ⚠️★ 这份放行表是**契约**：main.go 里每加一条服务端路由，这里漏了就出故障
                    // （SW 的导航兜底把点击整个吞掉、返回预缓存里的 index.html）。
                    // Go 侧有契约测试 TestSpaServiceWorkerCoversEveryServerRoute 盯着这份名单。
                    navigateFallbackDenylist: [
                        /^\/s\//,
                        /^\/server/,
                        /^\/text/,
                        /^\/auth/,
                        /^\/upload/,
                        /^\/push/,
                        /^\/rooms/,
                        /^\/share/,
                        /^\/file\//,
                        /^\/revoke/,
                        // ⚠️ `/^\/content/` 而**不是** `/^\/content\//` —— `GET /content` 也是一条
                        // 服务端路由，带斜杠的写法会让它落进 SW 的导航兜底。
                        /^\/content/,
                        /^\/push/,
                        /^\/automation/,
                        /^\/tasks/,
                    ],
                    runtimeCaching: [
                        {
                            urlPattern: /^\/(server|text|auth|upload|push|rooms|share|file|revoke|content|tasks|myip)/,
                            handler: 'NetworkOnly',
                            method: 'GET',
                        },
                    ],
                },
            }),
        ],
        define: {
            // 交给 src/services/swUpdate.ts 消费（设置弹窗展示 + 「现在刷还是等会刷」的判定）
            'import.meta.env.__BUILD_ID__': JSON.stringify(buildId),
        },
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
            },
        },
        base: '',
        build: {
            outDir: 'dist',
            sourcemap: false,
            chunkSizeWarningLimit: 600,
            rollupOptions: {
                output: {
                    manualChunks(id: string) {
                        if (!id.includes('node_modules')) {
                            return undefined;
                        }
                        if (id.includes('/@mui/') || id.includes('/@emotion/') || id.includes('/@mdi/') || id.includes('mdi/fonts')) {
                            return 'mui';
                        }
                        if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/react-router') || id.includes('/scheduler/')) {
                            return 'react-core';
                        }
                        if (id.includes('/i18next') || id.includes('/react-i18next')) {
                            return 'i18n';
                        }
                        if (id.includes('/axios') || id.includes('/qrcode.react')) {
                            return 'vendor';
                        }
                        return undefined;
                    },
                },
            },
        },
        server: {
            port: 1210,
            proxy: {
                '/server': { target: 'http://localhost:9501/', changeOrigin: true },
                '/push': { target: 'http://localhost:9501/', changeOrigin: true, ws: true },
                '/auth': { target: 'http://localhost:9501/', changeOrigin: true },
                '/rooms': { target: 'http://localhost:9501/', changeOrigin: true },
                '/share': { target: 'http://localhost:9501/', changeOrigin: true },
                '/file': { target: 'http://localhost:9501/', changeOrigin: true },
                '/text': { target: 'http://localhost:9501/', changeOrigin: true },
                '/upload': { target: 'http://localhost:9501/', changeOrigin: true },
                '/revoke': { target: 'http://localhost:9501/', changeOrigin: true },
                '/content': { target: 'http://localhost:9501/', changeOrigin: true },
                // 定时自动化：管理页 `/automation` 与它调的接口 `/tasks`（服务端渲染的独立页面，
                // 不代理的话会被 vite 的 SPA 回退接住、回到首页）。
                '/automation': { target: 'http://localhost:9501/', changeOrigin: true },
                '/tasks': { target: 'http://localhost:9501/', changeOrigin: true },
                // ⚠️ `/s/` **刻意不代理**（理由见 web-vue3/vite.config.js 那段注释）。
            },
        },
    };
});
