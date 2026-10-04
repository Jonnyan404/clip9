/// <reference types="vite/client" />

// 构建期由 vite.config.ts 的 `define` 注入的构建指纹（dev 下固定 'dev'）。
// 与 `<html data-build-id>` 是同一个值，用来核对「线上跑的是哪次构建」。
interface ImportMetaEnv {
    readonly __BUILD_ID__: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
