/// <reference types="vite/client" />

// 构建期由 vite.config.ts 的 `define` 注入的构建指纹（dev 下固定 'dev'）。
// 与 `<html data-build-id>` 是同一个值，用来核对「线上跑的是哪次构建」。
interface ImportMetaEnv {
    readonly __BUILD_ID__: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// 部署时可改的运行时配置（`public/config.js`）—— 见 `src/lib/base.ts` 的 `API_BASE_URL`。
// ⚠️ 它是**运行时**读的（`window` 上的值），不是构建期常量，所以放在 `Window` 上而不是 `ImportMetaEnv`。
interface Window {
    /** 后端根地址；留空/不设 = 与页面同源。 */
    __CLIP9_API_BASE__?: string;
}
