import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ⚠️★ 2026-10-04：**这个前端已不是生产前端** —— 生产换成 `web/`（React 版），
// 发布链路（`tools/sync-web-assets.mjs`）也已指向 `web/`。所以这里**刻意不再同步**：
// 若照旧调 sync-web-assets，它会用默认源 `web/dist` 去覆盖 `rust/crates/server/static/`
// —— 明明是在编 Vue 版、入库的却是 React 产物，症状极难查。
// `web-vue3/` 现在只留作比对（见 dev-docs/specs/react-migration-plan.md 附四）。
if (process.env.DEPLOY_STATIC === '1') {
    console.log(
        '⚠️ web-vue3 已不是生产前端 —— DEPLOY_STATIC 在这里**不再同步**。\n' +
            '   要发布前端请到 web/ 里跑：npm run deploy'
    );
} else {
    console.log(
        'after-build: gz/br generated in dist/. Set DEPLOY_STATIC=1 to copy into rust/crates/server/static.'
    );
}
