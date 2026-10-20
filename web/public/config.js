/**
 * 部署时可改的一小份运行时配置 —— **整个文件只有这一行是有效的**。
 *
 * ⚠️★ 为什么要有它：前端产物是**一份**（`npm run build` 出来的东西对谁都一样），而
 * 「后端在哪」是**每处部署自己的事**。写进构建期常量（`import.meta.env`）的话，
 * 同一个产物换个部署就得重编一次；而这个文件是**纯静态**的，托管方改一行就换了一个后端。
 *
 * 用法（前后端分离部署）：
 *
 *   1. 后端那边（clip9-server）把前端所在的来源写进白名单：
 *        clip9-server -allow-origin https://clip.example.com
 *      或者配置文件里 `server.allowOrigins: ["https://clip.example.com"]`。
 *      ⚠️ 这一步**不能省**：浏览器会因为 CORS 把请求拦下来，而服务端日志里什么都不会有。
 *
 *   2. 前端这边把下面那行改成后端的地址（**要完整**，带 http(s)://，写到端口为止）：
 *        window.__CLIP9_API_BASE__ = 'https://api.example.com/';
 *      ⚠️ 结尾斜杠可带可不带（会被归一）；**带路径是可以的** —— 后端部署在反代的
 *      子目录下时写成 `https://example.com/clip/`。
 *
 *   3. 留空（默认）= 与页面同源，也就是「服务端自己渲染这一份前端」的常规部署 —— 
 *      这时候不需要配任何东西，也不需要 `allowOrigins`。
 *
 * ⚠️ 用户也可以在界面「设置 → 后端地址」里改（存 localStorage，优先于这个文件）；
 * 那个入口在**被嵌进桌面客户端的 iframe 里时不显示** —— 桌面端有自己的服务端，
 * 在那里改会把网页视图指到别的地方去。
 *
 * ⚠️ 这个名字（`config.js`）与它的位置（产物根目录）是**契约**：
 * `web/index.html` 用 `<script src="./config.js">` 引它，
 * `web/scripts/check-contracts.mjs` 的判据 I 盯着这两处。改名字要一起改。
 */
window.__CLIP9_API_BASE__ = '';
