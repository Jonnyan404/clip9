import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 给 dist 里的 js/css/html/svg 各生成 .gz / .br，并在 DEPLOY_STATIC=1 时把 dist 同步进
// `rust/crates/server/static/`（那一份会被 `include_bytes!` 编进 clip9-server）。
//
// ⚠️★ 同步**委托给** `tools/sync-web-assets.mjs` —— 它是「前端产物进服务端」的**唯一入口**
// （会挪走旧目录、逐个报新增/改动/消失、带 `--check`）。两条路各写一份拷贝逻辑
// = 同一个动作两处实现，不再加第二处。
//
// ⚠️★ 2026-10-04 起**生产前端就是 `web/`（React 版）**：在此之前这里刻意不调同步
//（那时发布链路指向 `web-vue3`，把 web/dist 塞进去会让同步清单记下一份自相矛盾的指纹）。
// 现在 sync-web-assets 的 FE 已指向 `web/`，两边对齐，做法与 web-vue3 的 after-build 一致。

const here = dirname(fileURLToPath(import.meta.url));
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
    execFileSync(process.execPath, [join(here, '..', 'tools', 'sync-web-assets.mjs')], {
        stdio: 'inherit',
    });
} else {
    console.log(
        'after-build: 未设置 DEPLOY_STATIC=1 —— 跳过同步进 rust/crates/server/static。\n' +
            '   要入库（会被编进 clip9-server）就跑：npm run deploy'
    );
}
