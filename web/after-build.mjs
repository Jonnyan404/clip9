import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从 web-vue3/after-build.js 移植：给 dist 里的 js/css/html/svg 各生成 .gz / .br。
// ⚠️★ 与原版的**唯一差异**：这里**不调用** tools/sync-web-assets.mjs。
//
// 原因：那个脚本把前端源目录**硬编码为 `web-vue3`**（默认源 `web-vue3/dist`，源码指纹
// 也算 `web-vue3` + `shortcuts`）。`web/` 在过渡期**不进发布产物**（计划 §7：Phase 7 才
// 替换 web-vue3），此时若把 web/dist 塞进 `rust/crates/server/static`，同步清单里记下的
// 源码指纹会是 web-vue3 的 —— 那是一份**自相矛盾**的清单，`--check` 会一直红。
//
// 所以这里只做压缩。发布链路的切换（把 sync-web-assets.mjs 的 FE 指向 web/）是 Phase 7 的任务。

const distDir = fileURLToPath(new URL('./dist', import.meta.url));

function compress(dir) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const s = statSync(full);
        if (s.isDirectory()) {
            compress(full);
        } else if (/\.(js|css|html|svg)$/.test(name)) {
            const buf = readFileSync(full);
            writeFileSync(full + '.gz', gzipSync(buf));
            writeFileSync(full + '.br', brotliCompressSync(buf));
        }
    }
}

compress(distDir);
console.log('after-build: gz/br generated in dist/.');

if (process.env.DEPLOY_STATIC === '1') {
    console.log(
        '⚠️ DEPLOY_STATIC 在 web/ 里**暂不生效** —— 发布链路仍指向 web-vue3。\n' +
            '   切换见 dev-docs/specs/react-migration-plan.md §7 Phase 7。'
    );
}
