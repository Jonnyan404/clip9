#!/usr/bin/env node
// 飞牛 fnOS 的 `.fpk` 安装包：**源文件之间那几处会静默漂掉的约定**。
//
// 用法：
//   node tools/fnos-package-smoke.mjs
//
// # ⚠️ 为什么要有它
//
// `.fpk` 是「一堆约定凑出来的目录树」，而这里面的错**没有一个是会报错的**：
//
//   · 端口写在**四处**（`manifest` 的 `service_port`、`clip9.sc` 的 `src.ports`、
//     `ui/config` 的 `port`、`cmd/service-setup` 里的默认值）。任何一处漂了，症状都是
//     「装上了、能跑、但桌面图标点开是白的 / 应用中心说端口被占」；
//   · `desktop_applaunchname` 与 `ui/config` 里那个键对不上 → 桌面**没有图标**
//     （装得上、也能从应用中心点开，所以没人会往「元数据」上想）；
//   · `cmd/service-setup` 里的二进制路径与打包脚本放进去的路径不一致 → 服务起不来，
//     日志只有一句「not found」，看着像「包装坏了」；
//   · `manifest` 的 `version` / `checksum` 是**占位符**，靠打包脚本改写。脚本要是被人
//     「顺手简化」掉那三行 `sed`，装出来的包 version=0.0.0、checksum 对不上；
//   · 图标尺寸不对 → 桌面图标糊成一片，或者干脆不显示。
//
// 所以这里只做**静态一致性**（秒级、不需要网络、不需要产物）；包本身的
// 结构 / checksum / 架构由 `fnos/scripts/package-fnos.sh` 打完当场自检（那一步要真产物）。
//
// # 判据（任何一条不过就红）
//
// 1. 必备文件齐全（少一个就装不成 / 装成没有入口的样子）；
// 2. 端口四处一致；
// 3. `desktop_applaunchname` 与 `ui/config` 的键一致；
// 4. `config/privilege` 是 `run-as: package`，且用户名与 `data-share` 的 `rw` 一致；
// 5. `manifest` 三格是占位符，且打包脚本**确实会改写**它们；
// 6. `cmd/service-setup` 的 `-config` / `-data` 都落在 `${TRIM_PKGVAR}` 里
//    （落到别处 = 升级时丢历史）；
// 7. 服务脚本引用的二进制路径 === 打包脚本放进去的那个路径；
// 8. 两张图标的像素尺寸真的是 64 / 256；
// 9. `config/resource` 的 `protocol-file` 指向一个存在的文件；
// 10. `release.yml` 有 `fnos` + `publish-fnos` 两个作业，且后者**数得出 2 个包**；
// 11. 产物名守全仓那条规则（`v<版本>` 紧跟 `clip9-fnos`）。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FNOS = join(ROOT, 'fnos');

const problems = [];
const bad = (msg) => problems.push(msg);

const read = (rel) => {
    const p = join(FNOS, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const readJson = (rel) => {
    const raw = read(rel);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        bad(`fnos/${rel} 不是合法 JSON：${e.message}`);
        return null;
    }
};

// ── 1. 必备文件 ──────────────────────────────────────────────────────────────
const REQUIRED = [
    'manifest',
    'clip9.sc',
    'ICON.PNG',
    'ICON_256.PNG',
    'cmd/service-setup',
    'config/privilege',
    'config/resource',
    'ui/config',
    'ui/images/64.png',
    'ui/images/256.png',
    'scripts/package-fnos.sh',
];
for (const rel of REQUIRED) {
    if (!existsSync(join(FNOS, rel))) bad(`缺 fnos/${rel} —— 打出来的包会装不上或者没有桌面入口`);
}

const manifest = read('manifest');
const sc = read('clip9.sc');
const ui = readJson('ui/config');
const privilege = readJson('config/privilege');
const resource = readJson('config/resource');
const service = read('cmd/service-setup');
const pkgScript = read('scripts/package-fnos.sh');

if (manifest === null) bad('读不到 fnos/manifest');
if (sc === null) bad('读不到 fnos/clip9.sc');
if (service === null) bad('读不到 fnos/cmd/service-setup');
if (pkgScript === null) bad('读不到 fnos/scripts/package-fnos.sh');

// ── 2. 端口四处一致 ──────────────────────────────────────────────────────────
if (manifest !== null && sc !== null && ui !== null && service !== null) {
    const pick = (re, text, what) => {
        const m = re.exec(text);
        if (!m) {
            bad(`从 ${what} 里读不出端口`);
            return null;
        }
        return m[1];
    };
    const pManifest = pick(/^service_port\s*=\s*(\d+)/m, manifest, 'manifest 的 service_port');
    const pScSrc = pick(/^src\.ports\s*=\s*"(\d+)\/tcp"/m, sc, 'clip9.sc 的 src.ports');
    const pScDst = pick(/^dst\.ports\s*=\s*"(\d+)\/tcp"/m, sc, 'clip9.sc 的 dst.ports');
    const urlEntry = ui['.url'] && Object.values(ui['.url'])[0];
    const pUi = urlEntry && String(urlEntry.port);
    const pService = pick(/APP_PORT="\$\{APP_PORT:-(\d+)\}"/, service, 'service-setup 的默认端口');

    const ports = [pManifest, pScSrc, pScDst, pUi, pService].filter(Boolean);
    if (new Set(ports).size > 1) {
        bad(
            `端口在几处不一致：manifest=${pManifest} sc.src=${pScSrc} sc.dst=${pScDst} ` +
                `ui=${pUi} service-setup=${pService} —— 症状是「图标点开是白的」或「应用中心说端口被占」`,
        );
    }
}

// ── 3. 桌面入口的键 ──────────────────────────────────────────────────────────
if (manifest !== null && ui !== null) {
    const m = /^desktop_applaunchname\s*=\s*(\S+)/m.exec(manifest);
    const key = m && m[1];
    const keys = Object.keys(ui['.url'] || {});
    if (!key) {
        bad('manifest 里没有 desktop_applaunchname');
    } else if (!keys.includes(key)) {
        bad(
            `manifest 的 desktop_applaunchname=${key}，而 ui/config 里只有 ${keys.join(', ')} —— ` +
                '装得上、能跑，但桌面**没有图标**',
        );
    }
    if (!/^desktop_uidir\s*=\s*ui$/m.test(manifest)) {
        bad('manifest 的 desktop_uidir 不是 ui —— 平台找不到桌面入口那个目录');
    }
}

// ── 4. 非 root + 数据目录共享 ────────────────────────────────────────────────
if (privilege !== null) {
    if (!privilege.defaults || privilege.defaults['run-as'] !== 'package') {
        bad('config/privilege 的 run-as 不是 package —— 服务会以 root 跑（数据目录里的文件也归 root）');
    }
    const user = privilege.username;
    if (!user) {
        bad('config/privilege 没有 username');
    } else {
        const shares = (resource && resource['data-share'] && resource['data-share'].shares) || [];
        const rw = shares.flatMap((s) => (s.permission && s.permission.rw) || []);
        if (shares.length === 0) {
            bad('config/resource 没有 data-share —— 用户在「文件管理」里看不到上传的文件，备份也带不走');
        } else if (!rw.includes(user)) {
            bad(`data-share 的 rw 列表里没有 ${user}（实际 ${JSON.stringify(rw)}）—— 共享文件夹挂上但写不进去`);
        }
    }
}

// ── 5. manifest 的占位符 + 打包脚本确实改写 ─────────────────────────────────
if (manifest !== null && pkgScript !== null) {
    if (!/^version\s*=\s*0\.0\.0\s*$/m.test(manifest)) {
        bad('manifest 的 version 不是占位符 0.0.0 —— 它是模板，真版本由打包脚本写');
    }
    if (!/^checksum\s*=\s*$/m.test(manifest)) {
        bad('manifest 的 checksum 不是空占位符 —— 它是模板，真值由打包脚本算 md5 填');
    }
    for (const [re, what] of [
        [/s\/\^version\[\[:space:\]\]\*=\.\*\/version/, 'version'],
        [/s\/\^platform\[\[:space:\]\]\*=\.\*\/platform/, 'platform'],
        [/s\/\^checksum\[\[:space:\]\]\*=\.\*\/checksum/, 'checksum'],
    ]) {
        if (!re.test(pkgScript)) {
            bad(`打包脚本没有改写 manifest 的 ${what} —— 装出来的包会带着占位符`);
        }
    }
}

// ── 6. 数据与配置都必须落在 TRIM_PKGVAR 里 ──────────────────────────────────
if (service !== null) {
    if (!/APP_DATA_DIR="\$\{TRIM_PKGVAR\}"/.test(service)) {
        bad('service-setup 的 APP_DATA_DIR 不是 ${TRIM_PKGVAR} —— 数据会落到安装目录，升级时被换掉');
    }
    // ⚠️ `-data` 是必须的：配置里的 dbPath / storageDir 是**相对 -data** 解析的。
    if (!/-data \$\{APP_DATA_DIR\}/.test(service)) {
        bad('SERVICE_COMMAND 没有 `-data ${APP_DATA_DIR}` —— 库和上传会落到进程的 cwd，升级即丢');
    }
    if (!/-config \$\{APP_DATA_DIR\}\/config\.json/.test(service)) {
        bad('SERVICE_COMMAND 的 `-config` 不在 ${APP_DATA_DIR} 下 —— 配置会落在安装目录，升级即丢');
    }
    // ⚠️ 配置**不由脚本生成**：服务端自己会写默认配置，抄一份 JSON 就是多一处会漂的权威。
    if(/"server"\s*:/.test(service)) {
        bad('service-setup 里抄了一份配置 JSON —— 配置的权威是服务端（load_or_create），别在这儿再写一份');
    }
}

// ── 7. 二进制路径：脚本放的 === 服务脚本找的 ─────────────────────────────────
if (service !== null && pkgScript !== null) {
    const fromService = /SERVICE_COMMAND="\$\{APP_DIR\}\/(bin\/[A-Za-z0-9_.-]+)/.exec(service);
    const fromScript = /app\/bin\/clip9-cli/.exec(pkgScript);
    if (!fromService) {
        bad('service-setup 的 SERVICE_COMMAND 里读不出二进制路径（应当是 ${APP_DIR}/bin/<名字>）');
    } else if (!fromScript) {
        bad('打包脚本没有把二进制放到 app/bin/clip9-cli');
    } else if (fromService[1] !== 'bin/clip9-cli') {
        bad(
            `service-setup 找的是 ${fromService[1]}，而打包脚本放的是 bin/clip9-cli —— ` +
                '服务起不来，日志只有一句 not found',
        );
    }
}

// ── 8. 图标尺寸 ─────────────────────────────────────────────────────────────
// PNG 的 IHDR 是签名（8 字节）之后的第一块：4 字节长度 + 'IHDR' + 宽(4) + 高(4)，都是大端。
const pngSize = (rel) => {
    const p = join(FNOS, rel);
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};
for (const [rel, want] of [
    ['ICON.PNG', 64],
    ['ICON_256.PNG', 256],
    ['ui/images/64.png', 64],
    ['ui/images/256.png', 256],
]) {
    const size = pngSize(rel);
    if (!size) {
        bad(`fnos/${rel} 不是一张能读出尺寸的 PNG`);
    } else if (size.w !== want || size.h !== want) {
        bad(`fnos/${rel} 是 ${size.w}x${size.h}，应当是 ${want}x${want} —— 桌面图标会糊或者不显示`);
    }
}

// ── 9. 端口声明文件指向存在的文件 ───────────────────────────────────────────
if (resource !== null) {
    const file = resource['port-config'] && resource['port-config']['protocol-file'];
    if (!file) {
        bad('config/resource 没有 port-config.protocol-file —— 应用中心不知道这个应用占哪个端口');
    } else if (!existsSync(join(FNOS, file))) {
        bad(`config/resource 指向 ${file}，但 fnos/ 下没有这个文件`);
    }
}

// ── 10. release.yml 的接线 ──────────────────────────────────────────────────
const release = (() => {
    const p = join(ROOT, '.github/workflows/release.yml');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
})();
if (release === null) {
    bad('读不到 .github/workflows/release.yml');
} else {
    const job = (name) => {
        const start = release.indexOf(`\n  ${name}:`);
        if (start < 0) return null;
        const rest = release.slice(start + 1);
        const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\s*\n/);
        return next < 0 ? rest : rest.slice(0, next + 1);
    };
    const fnosJob = job('fnos');
    const pub = job('publish-fnos');
    if (fnosJob === null) {
        bad('release.yml 里没有 `fnos` 作业 —— 发布时不会打 .fpk');
    } else {
        if (!/pattern:\s*clip9-cli-linux-\*/.test(fnosJob)) {
            bad('release.yml 的 fnos 作业没有按 `clip9-cli-linux-*` 取那两个 musl 二进制');
        }
        if (!/package-fnos\.sh/.test(fnosJob)) {
            bad('release.yml 的 fnos 作业没有调 fnos/scripts/package-fnos.sh');
        }
    }
    if (pub === null) {
        bad('release.yml 里没有 `publish-fnos` 作业 —— 包打出来了但不会传上 Release');
    } else {
        // ⚠️ `files: extra/*` 匹配空是**静默**的（action-gh-release 会「成功地什么都没做」），
        //    所以这里要求它**数个数**，而数字必须与 package-fnos.sh 的平台表一致（x86 + arm）。
        if (!/clip9-fnos-v\*\.fpk/.test(pub)) {
            bad('publish-fnos 没有数 `clip9-fnos-v*.fpk` 的个数 —— 少了也没人知道');
        }
        if (!/=\s*2\b/.test(pub)) {
            bad('publish-fnos 没有断言「应当是 2 个包」（x86 + arm）');
        }
    }
}

// ── 11. 产物名守全仓那条规则 ────────────────────────────────────────────────
if (pkgScript !== null) {
    if (!/fpk_name="clip9-fnos-\$\{TAG\}-\$\{platform\}\.fpk"/.test(pkgScript)) {
        bad(
            '产物名不是 `clip9-fnos-v<版本>-<平台>.fpk` —— 全仓那条规则是「v<版本> 紧跟在 ' +
                'clip9-<东西> 之后」，其余限定词排在它后面',
        );
    }
}

// ── 结果 ────────────────────────────────────────────────────────────────────
if (problems.length > 0) {
    console.error(`✗ fnOS 安装包的约定没对齐（${problems.length} 处）：`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
}
console.log(
    '✓ fnOS 安装包自检通过：文件齐 · 端口四处一致 · 桌面入口对得上 · 非 root · ' +
        'manifest 由脚本改写 · 数据落在 PKGVAR · 图标尺寸对 · release 接线在',
);
