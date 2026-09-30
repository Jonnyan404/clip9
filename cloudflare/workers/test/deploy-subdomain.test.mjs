// 部署**不该替操作者表态**：`*.workers.dev` 那个开关现在是开是关，要被照原样写回配置。
//
// ⚠️ 为什么需要这条测试：`wrangler deploy` 会照着配置重设这个键，而**配置里不写 = 用默认值**，
// 默认是 `true` —— 于是「在控制台关掉 workers.dev」会被下一次部署**原样打开**
//（2026-09-30 报上来的那条）。修法是部署前读一次当前状态、照原样写回，而这条链上有
// **三处静默失效**的可能，一个都不会报错：
//
//   · 模板里那两行被删掉 → 写回时找不到目标（脚本会报错，但没人知道它本该存在）；
//   · 工作流 / 本地脚本忘了调那个脚本 → 又回到默认 `true`，**看起来一切正常**；
//   · 调用位置跑到 `wrangler deploy` **之后** → 写回的值对这次部署没有任何作用。
//
// ⚠️ 这个文件**不联网、不需要 wrangler**（沿用 run.sh 的约定）：只测纯函数 + 静态约定。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeChecker } from './harness.mjs';
import { decideSubdomain, workerNameOf, writeSubdomainLines } from '../../sync-workers-dev.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workersDir = join(here, '..'); // cloudflare/workers
const cloudflareDir = join(here, '..', '..'); // cloudflare
const repoRoot = join(here, '..', '..', '..');
const check = makeChecker();

// ── ① 模板必须**显式**写出那两个键 ──────────────────────────────────────────
// ⚠️ 这正是当初那个 bug 的成因：键不在文件里 = 没人在看它 = 没人知道部署会对它表态。
//    （生成出来的 `wrangler.toml` 被 .gitignore 忽略，本地有就一起查。）
for (const name of ['wrangler.toml.template', 'wrangler.toml']) {
    const path = join(workersDir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const key of ['workers_dev', 'preview_urls']) {
        check.check(
            `${name}: 显式写了 ${key}`,
            new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'm').test(text),
            true,
        );
    }
}

// ── ② 决定逻辑：三种输入各自的结果 ─────────────────────────────────────────
check.check('首次部署（还没有这个 Worker）→ 打开，让它有个地址', decideSubdomain(null), {
    workers_dev: true,
    preview_urls: true,
});
check.check(
    '已经关掉 → 照原样写回 false（部署不表态）',
    decideSubdomain({ enabled: false, previews_enabled: false }),
    { workers_dev: false, preview_urls: false },
);
check.check(
    '已经打开 → 照原样写回 true',
    decideSubdomain({ enabled: true, previews_enabled: true }),
    { workers_dev: true, preview_urls: true },
);
// ⚠️ 两个标志**各自独立**（API 也是分开的两个字段）：拿一个当另一个，会把
//    「关掉 workers.dev 但显式开着 Preview URLs」这种搭配顺手改掉 —— 那还是**部署表了态**。
check.check(
    '两个标志分开读，不互相顶替',
    decideSubdomain({ enabled: false, previews_enabled: true }),
    { workers_dev: false, preview_urls: true },
);

// ── ③ 只改那两行；键不在**报错**，不偷偷加一行 ───────────────────────────────
const SAMPLE = 'name = "w"\nworkers_dev = true\npreview_urls = true\n\n[assets]\ndirectory = "./assets"\n';
const written = writeSubdomainLines(SAMPLE, { workers_dev: false, preview_urls: false });
check.check(
    '两个键都被改写',
    /workers_dev = false\npreview_urls = false/.test(written.toml),
    true,
);
check.check('别的行一行没动', written.toml.includes('directory = "./assets"'), true);
check.check(
    '键不在时报出来（而不是顺手加一行）',
    writeSubdomainLines('name = "w"\n', { workers_dev: true }).missing,
    ['workers_dev'],
);
check.check('Worker 名从配置里读出来', workerNameOf('name = "clip9-worker"\n'), 'clip9-worker');

// ── ④ 两条部署路径都真的调了它，而且**在 deploy 之前** ──────────────────────
const workflow = readFileSync(join(repoRoot, '.github/workflows/deploy-cloudflare.yml'), 'utf8');
const syncAt = workflow.indexOf('sync-workers-dev.mjs');
// ⚠️ 锚在**真的那一次部署调用**上（Python 里 `Popen(["wrangler", "deploy"], …)`），
//    不锚在步骤名上 —— 步骤名改了不该让这条判据红，而部署调用改了正是该红的时候。
const deployMatch = workflow.match(/\[\s*["']wrangler["']\s*,\s*["']deploy["']/);
check.check('工作流调了 sync-workers-dev.mjs', syncAt > 0, true);
check.check('工作流里找得到那次 wrangler deploy', Boolean(deployMatch), true);
check.check(
    '写回**排在 deploy 之前**（排后面等于没写）',
    syncAt > 0 && Boolean(deployMatch) && syncAt < deployMatch.index,
    true,
);

const shell = readFileSync(join(cloudflareDir, 'deploy.sh'), 'utf8');
check.check('本地 deploy.sh 也调了同一个脚本', shell.includes('sync-workers-dev.mjs'), true);
check.check(
    'deploy.sh 里也在 deploy 之前',
    shell.indexOf('sync-workers-dev.mjs') > 0 &&
        shell.indexOf('sync-workers-dev.mjs') < shell.indexOf('wrangler deploy --env=""'),
    true,
);

check.summary('部署的 workers.dev 写回 ✅');
