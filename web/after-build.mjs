import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 在 DEPLOY_STATIC=1 时把 dist 同步进 `rust/crates/server/static/`
//（那一份会被 `include_bytes!` 编进 clip9-server），并给产物盖「构建输入指纹」的章。
//
// ⚠️★ 2026-10-20：**不再生成 `.gz` / `.br` 预压缩副本**（原来这一步给 dist 里每个
// js/css/html/svg 各写一份）。理由不是「省事」，是**没人读它们**：
//
//   · 服务端（`rust/crates/server/src/static_files.rs`）**没有**任何按 `Accept-Encoding`
//     挑预压缩文件的逻辑，也没有 `Content-Encoding` 分支 —— 它只按相对路径读内嵌的那一张表；
//   · 仓库里也没有一处 nginx `gzip_static` / `brotli_static` 配置在用它们。
//
//   而代价是实的：那 52 个文件 **6.3 MB**，跟着 `sync-web-assets` 一起进了 `static/`，
//   于是被 `include_bytes!` 编进**每一个**二进制（CLI / Docker / OpenWrt / Android / 桌面）。
//   前端产物本体 21 MB 里它占了 30% —— 对 flash 几十 MB 的路由器是实打实的一笔。
//
//   ⚠️ 要恢复它，得先有一个**真的会用它们**的消费者（例如给 `static_files` 加
//   `Accept-Encoding` 分支），否则别加回来：`check-contracts.mjs` 的判据 J 会红。
//
// ⚠️★ 同步**委托给** `tools/sync-web-assets.mjs` —— 它是「前端产物进服务端」的**唯一入口**
// （会挪走旧目录、逐个报新增/改动/消失、带 `--check`）。两条路各写一份拷贝逻辑
// = 同一个动作两处实现，不再加第二处。
//
// ⚠️★ 2026-10-04 起**生产前端就是 `web/`（React 版）**：在此之前这里刻意不调同步
//（那时发布链路指向 `web-vue3`，把 web/dist 塞进去会让同步清单记下一份自相矛盾的指纹）。
// 现在 sync-web-assets 的 FE 已指向 `web/`，两边对齐，做法与 web-vue3 的 after-build 一致。

const here = dirname(fileURLToPath(import.meta.url));

// ⚠️★ 盖「构建输入指纹」的章 —— 必须在**所有产物都写完**之后、在同步之前。
//
// 它堵的是一个真发生过的洞：`sync-web-assets.mjs` 的清单记的是**同步那一刻**的源码指纹，
// 所以「源码改了、构建没产出新 dist、同步照做」这条路上，清单拿到的是新指纹、
// `--check` 一路绿，而 `static/` 里装的是**旧产物**。
// 2026-10-11 真踩了（构建被本机安全删除钩子从 `emptyDir` 打断，`exit=1` 被当成无关紧要）。
//
// ⚠️ 同步**之前**：`sync-web-assets.mjs` 会核对这个章，盖晚了它就没得核。
execFileSync(process.execPath, [join(here, '..', 'tools', 'sync-web-assets.mjs'), '--stamp'], {
    stdio: 'inherit',
});

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
