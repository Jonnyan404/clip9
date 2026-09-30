#!/usr/bin/env node
// 从 Release 标签推出「版本号」与「Android 的 versionCode」——**只在这里定义一次**。
//
// 为什么要有它：`release.yml` / `openwrt.yml` / `android.yml` 三个地方都要这个换算，
// 而它们**各有各的入口**（发版时由 `release.yml` 传 tag，单独手动跑时自己就是入口）——
// 于是「抄一份一样的逻辑」和「只在一处定义」会打架。抄一份的代价在别处已经付过：
// 那种漂移只在发布时才响。
//
// 用法（输出是 `key=value` 三行，可直接 `>> "$GITHUB_OUTPUT"`）：
//   node tools/release-version.mjs --tag v0.1.0-beta1
//     → version=0.1.0-beta1
//       version_code=1000
//       wix_version=0.1.0.1
//   node tools/release-version.mjs                       # 没 tag → 读 rust/Cargo.toml
//   node tools/release-version.mjs --tag ''              # 同上（手动跑、没填 tag 那种）
//
// ⚠️★ `version` **不带 v** —— 两个地方拼包名时都自己补：打包脚本写 `…-v${VERSION}.ipk`，
//    Android 那边是 `clip9-android-v${VERSION}.apk`。
//
// ⚠️★ `versionCode` 是 **Android 要的整数**，且必须**单调递增**（装新版要有更大的号）。
//    规则取自 Go 版的 android.yml：`MAJOR*100000 + MINOR*1000 + PATCH`。
//    ⚠️ 但它**只取上面三段数字**，预发布后缀（`-beta1`）不参与 —— Go 那版是
//    `$(echo "${TAG#v}" | cut -d. -f3)`，拿到 `0-beta1` 会喂给 `$(( ))`，
//    正式发预发布版时才炸。这里显式剥掉非数字部分。
//
// ⚠️★ `wix_version` 是 **Windows MSI（WiX）要的形状**：`major.minor.patch.build`，
//    四段**全是数字**（major/minor ≤ 255，patch/build ≤ 65535）。
//    WiX 的 ProductVersion 只认数字，所以把 `0.1.1-beta2` 直接喂过去，会在打包那一步
//    报 `optional pre-release identifier in app version must be numeric-only`。
//    ⚠️ Tauri 为此留了 `bundle.windows.wix.version`（不设就从 `version` 推导）——
//    我们就是把这一份喂给它（`release.yml` 的 desktop job）。
//    ⚠️ NSIS **不需要**这一份：它原生支持完整 semver（上游 tauri#5286 里说的），
//    所以 Windows 那两个包里只有 msi 需要。
//    ⚠️★ 这个换算放在**这里**、不放在 yml 里，与 `version_code` 同一条理由：
//    换算只许有一个定义处，多一处就一定会在某次发版时漂。
//
// ⚠️★ build 段取值的规矩（**为了让 MSI 的 ProductVersion 严格单调**）：
//    · 预发布 → 取它的**尾号**（`beta2` → 2）；
//    · 正式版 → **65535**（最大值）。
//    → 于是 `0.1.1-beta1`(0.1.1.1) < `0.1.1-beta2`(0.1.1.2) < `0.1.1`(0.1.1.65535)
//      < `0.1.2-beta1`(0.1.2.1) —— 严格递增。
//    ⚠️ 为什么不图省事让正式版给 0：那样 `0.1.1`(0.1.1.0) 就**小于**同号的 beta，
//    「装不装得上」就得看 Windows 的降级拦截怎么设 —— `bundle.windows.allowDowngrades`
//    **默认 true**（schema 里写的），但那是**别人家的默认值**，不押它。
//
// ⚠️  没有 tag 时读的是 `rust/Cargo.toml` 的 `[workspace.package] version` —— 与
//    `openwrt/scripts/build.sh` 不给参数时的取法**同一个真值**（各成员的 `Cargo.toml`
//    写的是 `version.workspace = true`，所以只有那一处是准的）。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
let tag = '';
const tagFlag = argv.indexOf('--tag');
if (tagFlag >= 0) tag = argv[tagFlag + 1] ?? '';

const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

/** `v0.1.0-beta1` → `0.1.0-beta1`。⚠️ 只剥**开头**那个 `v`。 */
const stripV = (s) => (s.startsWith('v') ? s.slice(1) : s);

function versionFromCargo() {
  const path = join(ROOT, 'rust/Cargo.toml');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // ⚠️ 只认行首那一行（`[workspace.package]` 里那一个）。各成员的 Cargo.toml 里
  //    写的是 `version.workspace = true`，匹配不到这个模式 —— 所以不会取错。
  const m = /^version = "(.*)"$/m.exec(text);
  return m ? m[1] : null;
}

let version = stripV(tag.trim());
let from = 'tag';
if (!version) {
  version = versionFromCargo() ?? '';
  from = 'rust/Cargo.toml';
}
if (!version) {
  die('拿不到版本号：既没给 --tag，rust/Cargo.toml 里也没有 `version = "…"`');
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  die(`版本号长得不像 semver：${JSON.stringify(version)}（要形如 0.1.0 或 0.1.0-beta1）`);
}

// ⚠️ 只取前三段数字，预发布后缀不参与（见抬头那段）。
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!m) die(`从版本号里取不出三段数字：${JSON.stringify(version)}`);
const [, major, minor, patch] = m;
const versionCode = Number(major) * 100000 + Number(minor) * 1000 + Number(patch);
if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
  die(`算出来的 versionCode 不合法：${versionCode}`);
}

// ── `wix_version`：给 Windows MSI 用的**纯数字**版本（见抬头那段）────────────
//
// ⚠️ 先校验三段本身在 WiX 能表示的范围内 —— 超了要在**这里**报，
//    而不是等到 Windows runner 上打包到一半才由 WiX 吐一句难读的话。
if (Number(major) > 255 || Number(minor) > 255 || Number(patch) > 65535) {
  die(
    `版本号超出 MSI（WiX）能表示的范围（major/minor ≤ 255、patch ≤ 65535）：${version}\n` +
      '    Windows 那条打包会失败；改 package 版本号或另定一套 MSI 版本映射。',
  );
}
const preRaw = /-([0-9A-Za-z.-]+)/.exec(version)?.[1] ?? '';
const preTail = /(\d+)$/.exec(preRaw)?.[1];
// 预发布 → 尾号（`beta2` → 2）；正式版 → 65535（最大值，见抬头那段为什么）。
const build = preRaw ? Math.min(Number(preTail ?? 1) || 1, 65534) : 65535;
const wixVersion = `${major}.${minor}.${patch}.${build}`;
if (preRaw && !preTail) {
  console.error(
    `⚠️ 预发布段 ${JSON.stringify(preRaw)} 取不到尾号，MSI 版本按 1 算（${wixVersion}）——` +
      '它与 `-<别的字母>1` 会撞号，撞了只影响「能否靠 MSI 版本分辨」，不阻断发布',
  );
}

console.error(
  `版本号 ${version}（来源：${from}）· versionCode ${versionCode} · MSI ${wixVersion}`,
);
console.log(`version=${version}`);
console.log(`version_code=${versionCode}`);
console.log(`wix_version=${wixVersion}`);
