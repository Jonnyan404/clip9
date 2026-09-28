import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 默认只压缩 dist，不动服务端的产物目录。
//
// 显式设置 DEPLOY_STATIC=1 时，把 dist 同步进 `rust/crates/server/static`（那一份会被
// `include_bytes!` 编进 `clip9-server`）—— 委托给 `tools/sync-web-assets.mjs`，
// 它才是「前端产物进服务端」的**唯一入口**（会挪旧目录、逐个报新增/改动/消失、带 `--check`）。
// 两条路各写一份拷贝逻辑 = 同一个动作两处实现，不再加第三处。
if (process.env.DEPLOY_STATIC === '1') {
    execFileSync(process.execPath, [join(here, '..', 'tools', 'sync-web-assets.mjs')], {
        stdio: 'inherit',
    });
} else {
    console.log(
        'after-build: gz/br generated in dist/. Set DEPLOY_STATIC=1 to copy into rust/crates/server/static.'
    );
}
