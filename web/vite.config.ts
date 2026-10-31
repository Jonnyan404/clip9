import { fileURLToPath, URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { VitePWA } from 'vite-plugin-pwa';

// 从 web-vue3/vite.config.js 移植。三件事必须**原样保留**（改错不报错、只静默退化）：
//   1. build id 注入（bundle + `<html data-build-id>` 两处）；
//   2. PWA 的 `navigateFallbackDenylist`（漏一条服务端路由 → SW 导航兜底吞掉点击）；
//   3. dev 下注入 `<base href="/">`（history 深路径 `/s/<token>` 靠它把相对地址拉回根目录）。
// ⚠️ 2026-10-30 起 `web-vue3/`（Vue 版）已从仓库删掉 —— 这份配置现在只有一份，不用再对齐谁。
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
                // ⚠️★ 这里列的东西会**绕过 `globIgnores` 直接进预缓存**（vite-plugin-pwa 把它们
                //    单独塞进 manifest）。所以「预缓存瘦身」既要改 `globIgnores`，也要看这份清单 ——
                //    2026-10-31 就踩了：两个赞赏二维码在 `globIgnores` 里排掉了，却一直挂在
                //    这份 includeAssets 上，照样每次首屏都下（0.39 MB）。
                //    它们从 `public/` 复制到 dist 照旧，只是不再预缓存 —— 那两行 <img> 只在
                //    赞赏弹窗里显示，在线取就够；「离线也能看赞赏码」不是任何人的需求。
                //    ⚠️ 图标（favicon / pwa-* / apple-touch）必须留着：离线可用与主屏安装都靠它们。
                includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
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
                    // ⚠️★ **白板那一坨不进预缓存**（2026-10-10）。
                    //
                    // 为什么要专门排除：`globPatterns` 会把 `dist/assets/` 下**所有** js/css
                    // 都塞进预缓存 —— 包括懒加载的那些。而 Excalidraw 是个大依赖
                    // （它自己拖进 mermaid 全套图表 + katex + cytoscape，几 MB），
                    // 于是「只在白板 mode 才加载」这件事**被 PWA 一笔勾销**：
                    // 每个用户第一次访问都会在后台把它下完，而且每次发版（hash 变了）
                    // 都要重下。实测：排除前 `161 entries / 14718 KiB`，
                    // 排除后见 `web/scripts/check-whiteboard-plan.mjs` 的判据。
                    //
                    // ⚠️ 这是「懒加载」这件事**唯一**的牙：`React.lazy` 只保证**执行**推迟，
                    // 不保证**下载**推迟 —— 下载推迟靠的是「不预缓存 + 用到才 fetch」。
                    // 漏了这条，构建产物看起来完全正常，只是每个人多下几 MB。
                    //
                    // ⚠️★ 有一道**意外的**兜底值得知道：workbox 的
                    // `maximumFileSizeToCacheInBytes` 默认是 2 MiB，**超了它会让构建直接失败**
                    // （不是静默跳过）。2026-10-10 实测：把下面这行删掉，`npm run build` 当场报
                    // 「assets/whiteboard-*.js is 7.63 MB, and won't be precached」并退出 1。
                    // 所以「忘了排除」这个错**是响的** —— 但只在那一坨**大于 2 MiB** 时响；
                    // 小于 2 MiB 的残留 chunk 仍会被静默预缓存，那部分靠
                    // `web/scripts/check-whiteboard-plan.mjs` 的预缓存判据盯着。
                    // ⚠️★ `config.js`（部署时可改的后端地址）也**不许**预缓存（2026-10-20）。
                    // 它存在的全部意义就是「托管方改一行就换了个后端」，而预缓存会让
                    // 「改完刷新看看」这件事**没有反应** —— 回访用户拿到的还是缓存里那份旧的，
                    // 而 SW 的更新检查只看 SW 脚本本身，那个文件改了不会触发任何更新。
                    // ⚠️ 两种写法都列上：`**/` 在这里是否吃根目录取决于 glob 实现，
                    // 而漏掉它的症状是静默的（只是「改了不生效」）。
                    globIgnores: [
                        '**/whiteboard-*.js',
                        '**/whiteboard-*.css',
                        'config.js',
                        '**/config.js',
                        // ⚠️★ KaTeX 的字体也不许预缓存（2026-10-30，加了公式渲染之后）。
                        //    与上面同一条道理：公式是**懒加载**的，而 `globPatterns` 里的
                        //    `woff2/woff/ttf` 会把 24 个字体（woff2 合计 254 KB）一次性塞进
                        //    首次安装 —— 绝大多数剪贴板内容里根本没有公式。
                        //    在线时用到哪个下哪个，离线时公式退回系统衬线字体
                        //    （KaTeX 的排版靠 CSS 的定位，不靠具体字形，所以不会散架）。
                        '**/KaTeX_*.woff2',
                        '**/KaTeX_*.woff',
                        '**/KaTeX_*.ttf',
                        // ⚠️★ 2026-10-31：下面三类同属「懒加载 / 永远不会被请求」，一律不许预缓存。
                        //    改之前实测首屏 **38 个文件 7.36 MB**，其中 4.68 MB（64%）属于这一类 ——
                        //    每个用户第一次访问就把它们下完，而绝大多数人一辈子用不上。
                        //
                        // ① MDI 图标字体**只留 woff2**（394 KB）。eot / ttf / woff 是老浏览器兜底：
                        //    `@mdi/font` 的 `@font-face` 里 woff2 排在第一个支持的格式，
                        //    现代浏览器**只下它一个**，那三种永远不会被请求 —— 但 `globPatterns`
                        //    里的 `eot,woff,ttf` 照样把它们塞进了预缓存（1.25 + 0.56 + 1.25 MB）。
                        //    ⚠️ `*.woff` **不会**匹配 `*.woff2`（后缀不同），所以 woff2 还在。
                        // ② opencc（1.14 MB）与 pinyin（0.29 MB）：动作库里本来就是 `await import()`
                        //    （见 `lib/actions/impl.js`），只有「转简体/繁体」「拼音排序」才用得到。
                        //    ⚠️ 代码上是懒的，**下载上不是** —— 这就是本节标题那句「懒加载唯一一只有牙」。
                        // ③ 赞赏二维码：只在赞赏弹窗里显示，没人盼着它离线可用。
                        '**/materialdesignicons-webfont*.eot',
                        '**/materialdesignicons-webfont*.woff',
                        '**/materialdesignicons-webfont*.ttf',
                        '**/opencc-*.js',
                        '**/pinyin-*.js',
                        // ⚠️ 两种写法都列上（同 `config.js` 那条）：`reward-*.png` 在 **dist 根目录**，
                        //    而 `**/` 前缀是否吃根目录取决于 glob 实现 —— 2026-10-31 实测：只写
                        //    `**/` 那份**没生效**，两个二维码照样进了预缓存。
                        'reward-*.png',
                        '**/reward-*.png',
                    ],
                    cleanupOutdatedCaches: true,
                    navigateFallback: 'index.html',
                    // ⚠️★ 这份放行表是**契约**：服务端每加一条路由，这里漏了就出故障
                    // （SW 的导航兜底把点击整个吞掉、返回预缓存里的 index.html）。
                    //
                    // ⚠️ 这条契约**现在没有守卫**：原来盯着它的是 Go 侧的
                    // `TestSpaServiceWorkerCoversEveryServerRoute`，随前身实现一起没了。
// `web/scripts/check-contracts.mjs` 的判据 D 里有一张**必须放行**的清单
// （`DENY_REQUIRED`）—— 加服务端路由时记得手改这里和那张清单，两处都漏才是真漏。
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
                        // 文档 → Markdown（`POST /convert/{uuid}`，2026-10-10 加）。
                        // ⚠️ 它**只在服务端带了 `doc` feature 时存在**，但放行表照加不误 ——
                        // 这份表是「别让 SW 吞掉服务端路径」，与那条路由在不在无关。
                        /^\/convert/,
                    ],
                    runtimeCaching: [
                        {
                            urlPattern: /^\/(server|text|auth|upload|push|rooms|share|file|revoke|content|tasks|myip|convert)/,
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
                        // ⚠️★ 白板那一坨**必须排在最前面**，而且要**整个桶装走**（2026-10-10）。
                        //
                        // 为什么单独一个 chunk：白板是懒加载的，而懒加载只有在
                        // 「它能被单独切出去」时才有意义 —— 散成一堆小 chunk 的话，
                        // 上面 `globIgnores` 的 `whiteboard-*` 前缀就只盖住一部分，
                        // 剩下的照样进预缓存（症状：构建完全正常，只是每个人多下几 MB）。
                        //
                        // ⚠️ 列的是 Excalidraw 拖进来的**全部重货**：它自己 + mermaid
                        // （以及 mermaid 那一堆按需加载的图表类型）+ katex + cytoscape +
                        // 手绘相关的 roughjs / perfect-freehand。少列一个，那个包就会
                        // 以别的名字落到 `assets/` 下，绕开 `globIgnores`。
                        // ⚠️ 加完记得看构建输出：`precache` 的 KiB 不该跟着涨。
                        if (
                            id.includes('/@excalidraw/') ||
                            id.includes('/mermaid/') ||
                            id.includes('/katex/') ||
                            id.includes('/cytoscape/') ||
                            id.includes('/roughjs/') ||
                            id.includes('/perfect-freehand/') ||
                            id.includes('/points-on-curve/') ||
                            id.includes('/points-on-path/') ||
                            id.includes('/path-data-parser/') ||
                            id.includes('/image-blob-reduce/') ||
                            id.includes('/open-color/')
                        ) {
                            return 'whiteboard';
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
                        // ⚠️ 这两个**显式**分组（2026-10-31）：它们虽然是 `await import()` 的懒加载模块，
                        //    但 `globIgnores` 是按**文件名**排除的 —— 靠 vite 自动命名的话，
                        //    哪天包名变了（或换实现）chunk 就叫不出 `opencc-*` / `pinyin-*`，
                        //    排除规则会**静默失效**（症状：构建正常、回访不受影响，只是首屏多下 1.4 MB）。
                        //    钉死组名，`globIgnores` 才有稳定的东西可指。
                        if (id.includes('/opencc-js/')) {
                            return 'opencc';
                        }
                        if (id.includes('/pinyin-pro/')) {
                            return 'pinyin';
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
                // 房间活跃度（`GET /stats/daily`，热力图用的）。⚠️★ 漏了它的症状**只在 dev 下出现**：
                // 请求打到 vite 自己（没有这条路由）→ 被 SPA 兜底用 **200 + 一份 index.html** 接住
                // → 前端拿不到 `activity`，对话框画成一片空白（2026-10-07 用户报的「热力图不出图」）。
                // ⚠️ 打包版没这条路（相对路径直接打到服务端）—— 两边的表现不一样，别只验一边。
                '/stats': { target: 'http://localhost:9501/', changeOrigin: true },
                // 定时自动化：管理页 `/automation` 与它调的接口 `/tasks`（服务端渲染的独立页面，
                // 不代理的话会被 vite 的 SPA 回退接住、回到首页）。
                '/automation': { target: 'http://localhost:9501/', changeOrigin: true },
                '/tasks': { target: 'http://localhost:9501/', changeOrigin: true },
                '/convert': { target: 'http://localhost:9501/', changeOrigin: true },
                // ⚠️★ 文档 → Markdown（`POST /convert/{uuid}`，2026-10-10 加）。
                //
                // 漏了它的症状**只在 dev 下出现**，而且**指向完全错误的方向**：
                // 请求打到 vite 自己 → SPA 兜底回一个**没有 body 的 404** →
                // 前端把它当成「这个服务端没编 `doc` feature」，
                // 于是提示「换一份带它的构建」——而服务端明明编了。
                // 2026-10-10 实测复现：服务端 `--all-features` 且 `convert.enabled: true`，
                // dev 下导入仍然报「缺少 doc」。
                // ⚠️ 判据：`check-contracts.mjs` 的「PWA 放行表里的每条服务端路由都要被代理」。
                // ⚠️ `/s/` **刻意不代理**（理由见 web-vue3/vite.config.js 那段注释）。
            },
        },
    };
});
