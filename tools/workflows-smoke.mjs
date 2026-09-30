#!/usr/bin/env node
// `release.yml` ↔ `openwrt.yml` / `android.yml` 之间那几条**跨文件约定**的静态门禁。
//
// ⚠️ 为什么要有它：这两个工作流**本机跑不起来**（要 GitHub 的 runner、Android SDK、
// Docker 里的 apk-tools），而它们与 `release.yml` 之间靠一堆**字符串**连着 ——
// artifact 名字、glob 前缀、矩阵条目数。断了的症状是：
//
//   · 上游 `upload-artifact` 改了名 → 下游 `download-artifact` 取不到 →
//     `action-gh-release` 的 `files` 匹配空是**静默的**，于是「成功地什么都没做」；
//   · `openwrt.yml` 的矩阵改了条目数 → `release.yml` 里那句 `[ "$n_ipk" = 7 ]` 红，
//     但那是**发布时才红**，而且看不出是「那边加了架构」；
//   · 两个可复用工作流的 `release` job 少了 `workflow_dispatch` 那道判断 →
//     被 release.yml 调用时**也会**去覆盖上传，两个 job 同时动一个 Release；
//   · `abiFilters` 里列着某个 ABI，而 `rust-toolchain.toml` 里没有对应 target →
//     那个 `.so` **静默不编**，最后由 APK 在设备上 `System.loadLibrary` 炸。
//   · 调可复用工作流时少写 `secrets:` / `secrets: inherit` → 被调文件里那些
//     `secrets.X` 全是**空串**，而它自己会报「secret 没设」（其实设了）；
//     ⚠️ 手动 dispatch 却是好的（那时它读得到仓库 secret）→ 症状像「只有 release 坏」。
//   · `openwrt/scripts/build.sh` 让几个 target 共用 `target/` → 宿主构建脚本跨镜像复用，
//     第二个 target 起报 `GLIBC_2.28 not found`（cross#724），报的却是某个依赖的名字。
//
// ⚠️★ 这些字符串**没有编译器看着**，也没有测试运行器 —— 与
// `tools/android-contract-smoke.mjs` / `share-bridge-smoke.mjs` 同一类。
//
// ⚠️ 解析用的是**正则**（仓库里没有 YAML 解析器，也不想为它加一个依赖）。
// 所以每个提取函数在「读不全 / 读不懂」时**返回 null 并让判据红**，而不是少解析几条
// 然后报一个「集合一致」—— 那会把真正的原因盖掉。每处都写了它是怎么判「读全了」的。
//
// 用法：
//   node tools/workflows-smoke.mjs
//   node tools/workflows-smoke.mjs --root <别的仓库根>    # 变异验证用

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let ROOT = resolve(HERE, '..');
const rootFlag = argv.indexOf('--root');
if (rootFlag >= 0) {
  if (!argv[rootFlag + 1]) {
    console.error('✗ --root 后面要跟一个路径');
    process.exit(2);
  }
  ROOT = resolve(argv[rootFlag + 1]);
}

const failures = [];
const fail = (label, detail) => failures.push({ label, detail });
/** 通过的判据条数。⚠️ 由 `ok()` 自己数 —— 别在报告里写死一个数字（写了就会变成假话）。 */
let okCount = 0;
const ok = (label) => {
  okCount += 1;
  console.log(`✓ ${label}`);
};

const read = (rel) => {
  const path = join(ROOT, rel);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

const RELEASE = '.github/workflows/release.yml';
const OPENWRT = '.github/workflows/openwrt.yml';
const ANDROID = '.github/workflows/android.yml';

// ── 提取 ─────────────────────────────────────────────────────────────────────

/**
 * 取某个 job 的 YAML 片段。
 * ⚠️ 只认**顶层 job 缩进**（两格）的开头，并用 `(?=^  \S)` 卡住结尾 ——
 * 不然会一路吃到下一个 job，甚至吃到别的文件里去（那类正则已经坑过一次）。
 * 读不到就返回 null（让判据红，不是静默）。
 */
function jobBlock(text, name) {
  const re = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|(?![\\s\\S]))`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const body = m[1];
  if (!body.trim()) return null;
  return body;
}

/** 某个 job 里 `needs:` 后面的 job 名（支持 `needs: [a, b]` 与多行 `- a`）。 */
function jobNeeds(text, name) {
  const body = jobBlock(text, name);
  if (body === null) return null;
  const inline = /^ {4}needs: \[([^\]]*)\]/m.exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const blockForm = /^ {4}needs:\n((?: {6}- \S+\n?)+)/m.exec(body);
  if (blockForm) {
    return [...blockForm[1].matchAll(/- (\S+)/g)].map((m) => m[1]);
  }
  // ⚠️★ **标量形式**（`needs: info`）也要认。仓库里 `openwrt` / `android` / 以及四个打包
  //    job 都是这么写的，而这里以前只认数组 → 它们被读成「没有 needs」，
  //    偏偏「没有 needs」是**合法**返回值（顶层 job 就是这样）—— 于是任何
  //    `needs.includes('info')` 的判据都判不出「他忘了加」。
  const scalar = /^ {4}needs: (\S+)\s*$/m.exec(body);
  if (scalar) return [scalar[1]];
  return []; // 没有 needs 是合法的（顶层 job）
}

/**
 * 取 `<key>:` 后面那个列表的**条目数**。
 * ⚠️ 两种写法都认：行内 `key: [a, b]`、以及块状（下一行起缩进更深的 `- …`）。
 * ⚠️★ 块状那条只数**列表项那一级缩进**上的 `- `（`base` 由第一条 `- ` 定），
 *    更深一层的不算 —— 因为条目可以是**多键映射**：
 *
 *        include:
 *          - arch: x86_64        ← 这一条要数
 *            pkg_arch: x86_64    ← 这是同一条的第二个键，缩进更深，不能数、也不能就此 break
 *
 *    2026-09-28 第一版在第二个键上 `break`，于是 8 格的矩阵被读成 1 格。
 * ⚠️ 见到「缩进 <= key 那一行」就停 —— 靠这个保证没吃到 key 之外的东西。
 * 读不懂（块里第一条不是 `- `）返回 null，让判据红。
 */
function listLen(text, key) {
  const re = new RegExp(`^( *)${key}: *(.*)$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const indent = m[1].length;
  const rest = m[2].trim();
  if (rest.startsWith('[') && rest.endsWith(']')) {
    const inner = rest.slice(1, -1).trim();
    return inner ? inner.split(',').length : 0;
  }
  if (rest !== '') return null; // `key: 某个标量` —— 这里期望的是列表
  const lines = text.slice(m.index + m[0].length).split('\n').slice(1);
  let base = null; // 列表项 `- ` 的缩进（由第一条定）
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ind = line.length - line.trimStart().length;
    if (ind <= indent) break; // 回到 key 那一层 → 列表结束
    const isItem = /^- /.test(line.trimStart());
    if (base === null) {
      if (!isItem) return null; // 块状列表的第一行不是条目 → 读不懂
      base = ind;
    }
    if (ind === base && isItem) n += 1;
  }
  return base === null ? 0 : n;
}

/**
 * 一个 job 片段里**每个** `upload-artifact` 步骤的 `name:`（即 artifact 名）。
 * ⚠️ 返回 `null` = 读不全（这个 job 里一个 upload 步骤都没有、或某个步骤没有 `with: name:`）——
 *    调用方拿它报红，**不能**当成「这个 job 不上传」：那正是要拦的那种情况。
 * ⚠️ `name:` 允许是**动态**的（`openwrt-pkg-ipk-${{ matrix.arch }}`）——照原样返回。
 *    那不是「读不准」：那个矩阵变量本就该在。要比的是 `${{` 之前那截字面量。
 * ⚠️★ 步骤 `- ` 的缩进**由 `steps:` 那一行推**（`+2`），不写死也不「见到 `- ` 就算」。
 *    2026-09-28 第一版就是「见到 `- ` 就算」，于是 `matrix` 的列表项（缩进 10 的
 *    `- aarch64`）也被当成一步，而它那一段一路吞到 job 末尾、把 `steps:` 与两个 `uses:`
 *    全吃进去 —— 于是 `openwrt-binaries`（**下载**那一步的 name）被当成了上传的 artifact 名。
 *    症状是「资产里混进一个不该出现的名字」，看不出是解析错。
 * ⚠️ `- uses: …` 与 `- name: …\n  uses: …` 两种写法都认（都从 `- ` 那一行起算）。
 */
function uploadNames(body) {
  if (body === null) return null;
  const steps = /^([ \t]*)steps:[ \t]*$/m.exec(body);
  if (!steps) return null; // 没有 `steps:` —— 不是普通 job 的形状，读不懂
  const indent = steps[1].length + 2; // 步骤 `- ` 的缩进 = `steps:` 的缩进 + 2
  const out = [];
  const stop = new RegExp(`^ {${indent}}- `);
  for (const m of body.matchAll(/^( *)- /gm)) {
    if (m[1].length !== indent) continue; // matrix 的列表项、run 里的缩进，都不是步骤
    const lines = body.slice(m.index + m[0].length).split('\n');
    const seg = [m[0] + lines[0]];
    for (const line of lines.slice(1)) {
      if (stop.test(line)) break;
      seg.push(line);
    }
    const step = seg.join('\n');
    if (!/uses: actions\/upload-artifact@v\d+/.test(step)) continue;
    // `with:` 之后那一行的 `name:` 才是 artifact 名（step 自己那个 `name:` 在 `with:` 之前）。
    const withAt = step.search(/^[ \t]+with:[ \t]*$/m);
    if (withAt < 0) return null;
    const name = /^[ \t]+name: (.+)$/m.exec(step.slice(withAt));
    if (!name) return null;
    out.push(name[1].trim());
  }
  return out.length ? out : null;
}

/** `openwrt-pkg-ipk-${{ matrix.arch }}` → `openwrt-pkg-ipk-`（`${{` 之前那截字面量）。 */
const literalHead = (s) => s.split('${{')[0];

/**
 * `release.yml` 里所有调**本仓库**可复用工作流的 job。
 * 返回 `[{ job, file, secrets }]`；`secrets` = `'inherit' | 'map' | 'other' | 'none'`。
 * `file` 是相对仓库根的路径（如 `.github/workflows/android.yml`），方便直接 `read()`。
 * ⚠️ `'other'` = `secrets:` 后面跟着读不懂的东西（行内 flow mapping 之类）——
 *    调用方拿它报红，**不**当成「没传」也**不**当成「传了」。
 * ⚠️ 只认**顶层 job 缩进**（两格）的 `uses:`（四格），与 `jobBlock` 同一套假设。
 */
function localWorkflowCalls(text) {
  if (text === null) return null;
  const out = [];
  for (const m of text.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)) {
    const job = m[1];
    const body = jobBlock(text, job);
    if (body === null) continue;
    const use = /^ {4}uses: \.\/\.github\/workflows\/(\S+)[ \t]*$/m.exec(body);
    if (!use) continue;
    const sec = /^ {4}secrets:(.*)$/m.exec(body);
    let secrets = 'none';
    if (sec) {
      const rest = sec[1].trim();
      if (rest === 'inherit') secrets = 'inherit';
      else if (rest === '') secrets = 'map';
      else secrets = 'other';
    }
    out.push({ job, file: `.github/workflows/${use[1]}`, secrets });
  }
  return out;
}

/** 某个 job 里第一个 `download-artifact` 的 `pattern:` 或 `name:`。 */
function downloadSelector(body) {
  if (body === null) return null;
  const m = /uses: actions\/download-artifact@v\d+/.exec(body);
  if (!m) return null;
  const seg = body.slice(m.index, m.index + 900);
  const pat = /^\s+pattern: (.+)$/m.exec(seg);
  if (pat) return { kind: 'pattern', value: pat[1].trim() };
  const name = /^\s+name: (.+)$/m.exec(seg);
  if (name) return { kind: 'name', value: name[1].trim() };
  return null;
}

// ── 读四个文件 ───────────────────────────────────────────────────────────────

const release = read(RELEASE);
const openwrt = read(OPENWRT);
const android = read(ANDROID);
const gradle = read('android/app/build.gradle.kts');
const syncJs = read('tools/sync-android-jni-libs.mjs');
const buildSh = read('openwrt/scripts/build.sh');
const toolchain = read('rust/rust-toolchain.toml');
const pkgIpk = read('openwrt/scripts/package-openwrt.sh');
const pkgApk = read('openwrt/scripts/package-openwrt-apk.sh');

// ── 判据 1：release.yml 取的东西，两个可复用工作流真的传了 ─────────────────
//
// ⚠️ 断一处的症状：`action-gh-release` 的 `files` 匹配空是**静默**的（「成功地什么都没做」）。
{
  const label = 'release.yml 的 artifact 名字/前缀 ↔ 两个工作流 upload 的 name';
  const pw = release === null ? null : jobBlock(release, 'publish-openwrt');
  const pa = release === null ? null : jobBlock(release, 'publish-android');
  const owUp = openwrt === null ? null : uploadNames(jobBlock(openwrt, 'binaries'));
  // ipk / apk / luci 三个 job 的 upload 名字都要看
  const owAll = ['ipk', 'apk', 'luci'].map((j) => uploadNames(openwrt === null ? null : jobBlock(openwrt, j)));
  const anUp = android === null ? null : uploadNames(jobBlock(android, 'apk'));
  const selW = downloadSelector(pw);
  const selA = downloadSelector(pa);

  const problems = [];
  // ⚠️ `owUp` 也要算进「读全了」：它读不出来的话下面那条「中间产物不该被当资产」的判据
  //    会因为集合为空而**静默通过** —— 那正是「假保护」。
  if (!owAll.every((x) => x) || !owUp || !anUp || !selW || !selA) {
    problems.push('读不全（某个 job / upload-artifact / download-artifact 没解析出来）');
  } else {
    // ⚠️ `openwrt-binaries` 是**中间产物**（给 ipk/apk 两个 job 用的裸二进制），
    //    它**不该**被 release.yml 当资产取走 —— 这条也一起判。
    const intermediate = owUp;
    const assets = owAll.flat();
    if (selW.kind !== 'pattern' || !selW.value.endsWith('*')) {
      problems.push(`release.yml 的 publish-openwrt 应该是 pattern 且以 * 结尾，实际 ${JSON.stringify(selW)}`);
    } else {
      const prefix = selW.value.slice(0, -1);
      // ⚠️ 动态名字（带 `${{ matrix.* }}`）只比**可确定的那截字面量**：后面那截由矩阵决定。
      //    这里判的是「前缀对不对」—— artifact 名字断掉时的症状正是它。
      for (const n of assets) {
        const head = literalHead(n);
        if (!head.startsWith(prefix)) {
          problems.push(`${OPENWRT} 里有个 upload name 是 ${n}，它可确定的那截 ${JSON.stringify(head)} 不以 ${prefix} 开头`);
        }
      }
      for (const n of intermediate) {
        if (literalHead(n).startsWith(prefix)) {
          problems.push(`${OPENWRT} 的中间产物 ${n} 也会被 ${selW.value} 取走（它不该当资产发出去）`);
        }
      }
    }
    if (selA.kind !== 'name') {
      problems.push(`release.yml 的 publish-android 应该按 name 取，实际 ${JSON.stringify(selA)}`);
    } else if (!anUp.includes(selA.value)) {
      problems.push(`release.yml 按 name=${selA.value} 取，而 ${ANDROID} 传的是 ${JSON.stringify(anUp)}`);
    }
  }

  if (problems.length) fail(label, problems.join('\n    '));
  else ok(label);
}

// ── 判据 1b：`publish` 取的范围**只有 cli / desktop**（中间产物不许混进去）────
//
// ⚠️★ 2026-09-29 加的。它判的是一件**真发生过**的事：v0.1.0-beta3 那个 Release 里躺着
//    7 个 `clip9-server-<版本>-<架构>` —— 那是 OpenWrt 的**裸二进制**，只是给 ipk / apk
//    两个 job 用的中间产物。原因：`publish` 的 `download-artifact` 原来**不带 `pattern`**，
//    会把整次运行里**所有** artifact 都拖下来，而那一刻 openwrt 的 `binaries` job 恰好
//    已经跑完了（**时序问题** —— 换个顺序可能就不出现，这正是它难查的地方）。
//    ⚠️★ 它的症状是「**没有症状**」：多出来的资产要等有人去翻 Release 页面才看得到。
//    ⚠️ 所以这里不只判「有没有 pattern」，还判那个 pattern **确实把中间产物排除在外**。
{
  const label = 'release.yml 的 publish 只取 cli / desktop（不带 pattern 会把中间产物一起传上去）';
  const problems = [];
  const pub = release === null ? null : jobBlock(release, 'publish');
  const sel = downloadSelector(pub);
  if (pub === null) {
    problems.push('读不到 release.yml 的 publish job');
  } else if (sel === null) {
    problems.push('publish 里的 download-artifact 没解析出来（改名了？少了？）');
  } else if (sel.kind !== 'pattern') {
    problems.push(
      `publish 的 download-artifact 是 ${JSON.stringify(sel)} —— 不带 pattern 会把整次运行的` +
        '**所有** artifact 都拖下来（含 `openwrt-binaries` 那种中间产物）。应当写 `clip9-*`。',
    );
  } else {
    // ⚠️ 前缀得是 `clip9-`：cli（`clip9-cli-*`）与 desktop（`clip9-desktop-*`）都在它下面，
    //    而中间产物 `openwrt-binaries` / `openwrt-pkg-*` 与 `android-apk` 都不在。
    for (const bad of ['openwrt', 'android']) {
      if (sel.value.includes(bad)) {
        problems.push(`publish 的 pattern ${JSON.stringify(sel.value)} 会连 ${bad} 的 artifact 一起取走`);
      }
    }
    if (!sel.value.startsWith('clip9-')) {
      problems.push(`publish 的 pattern 是 ${JSON.stringify(sel.value)}，应当以 \`clip9-\` 开头`);
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(`${label} —— pattern ${sel.value}`);
}

// ── 判据 1c：OpenWrt 包名**前缀**三处一致 ──────────────────────────────────
//
// ⚠️★ 2026-09-29 加的（包名从 `clip9-server-openwrt-*` 改成 `clip9-openwrt-*` 的那一次）。
//    同一个文件名在**三个文件**里各写了一份字面量：
//      ① `openwrt/scripts/package-openwrt{,-apk}.sh` 的 `IPK_NAME=` / `APK_NAME=`
//      ② `openwrt.yml` 里 upload 的 `path:`
//      ③ `release.yml` 的 `publish-openwrt` 里那两句 `find … -name`
//    ⚠️ 只改一处**不会静默**，但会**红在很晚的地方**：①② 不一致 → openwrt 那个 job 报
//    `if-no-files-found: error`（还算早）；②③ 不一致 → 一路跑到 `publish-openwrt`，
//    报的是「`ipk` 有 0 个」—— 而真正的错在另一个文件里。
//    ⚠️ 判的是**前缀**（第一个 `$` 之前那截）：版本号 / 架构那一段由变量拼，不该比。
{
  const label = 'OpenWrt 包名前缀：打包脚本 ↔ openwrt.yml 的 path ↔ release.yml 的 find';
  const problems = [];
  /** 从 `IPK_NAME="…"` 取**字面前缀**（第一个 `$` 之前那截）。 */
  const head = (text, re, what) => {
    const m = re.exec(text ?? '');
    if (!m) {
      problems.push(`读不到 ${what}`);
      return null;
    }
    const i = m[1].indexOf('$');
    return i < 0 ? m[1] : m[1].slice(0, i);
  };
  const ipkPrefix = head(pkgIpk, /IPK_NAME="([^"]+)"/, 'package-openwrt.sh 的 IPK_NAME');
  const apkPrefix = head(pkgApk, /APK_NAME="([^"]+)"/, 'package-openwrt-apk.sh 的 APK_NAME');
  const owIpk = openwrt === null ? null : jobBlock(openwrt, 'ipk');
  const owApk = openwrt === null ? null : jobBlock(openwrt, 'apk');
  const pw = release === null ? null : jobBlock(release, 'publish-openwrt');
  if (owIpk === null || owApk === null || pw === null) {
    problems.push('读不到 openwrt.yml 的 ipk / apk job 或 release.yml 的 publish-openwrt');
  } else {
    // ⚠️ 只在**各自的 job 块**里找：luci 那个 job 也有一句 `openwrt/build/clip9-luci-…`。
    const globIpk = /openwrt\/build\/([^*"]+)\*\.ipk/.exec(owIpk);
    const globApk = /openwrt\/build\/([^*"]+)\*\.apk/.exec(owApk);
    const findIpk = /-name '([^*']+)\*\.ipk'/.exec(pw);
    const findApk = /-name '([^*']+)\*\.apk'/.exec(pw);
    const pairs = [
      ['ipk', ipkPrefix, globIpk && globIpk[1], findIpk && findIpk[1]],
      ['apk', apkPrefix, globApk && globApk[1], findApk && findApk[1]],
    ];
    const seen = [];
    for (const [what, a, b, c] of pairs) {
      if (!a || !b || !c) {
        problems.push(`${what}：三处里有读不到的（打包脚本 ${JSON.stringify(a)} / openwrt.yml ${JSON.stringify(b)} / release.yml ${JSON.stringify(c)}）`);
        continue;
      }
      if (a !== b || a !== c) {
        problems.push(
          `${what} 的前缀三处不一致：打包脚本 ${JSON.stringify(a)}、openwrt.yml ${JSON.stringify(b)}、` +
            `release.yml 的 find ${JSON.stringify(c)}`,
        );
      } else {
        seen.push(`${what}=${a}`);
      }
    }
    if (!problems.length) ok(`${label} —— ${seen.join(' · ')}`);
  }
  if (problems.length) fail(label, problems.join('\n    '));
}

// ── 判据 1d：产物名里的 `v<版本>`（Jonny 2026-09-29：「要么都带版本号要么都不」）──
//
// ⚠️★ 2026-09-29 加的。这是全仓库一条规矩：`v<版本>` **紧跟在 `clip9-<东西>` 之后**
//    （细则写在 `release.yml` 的文件头）。cli / desktop 那四格原来**没有版本号** ——
//    因为 `linux` / `macos` / `windows` / `desktop` 当时**都没有 `needs: info`**，
//    手上根本没有 tag。（⚠️ 没有 needs 的 job 里写 `needs.info.outputs.tag` 不会报错，
//    它**渲染成空串** —— 产物名会变成 `clip9-cli--linux-x86_64` 那种样子。）
//    所以这里一次判两件事：① 四个 job 都 `needs: info`；② 它们确实拿它拼名字。
//    ⚠️ 漏掉的症状**只在发布时**才出现：`assets` 那份期望清单（同源，也是拿 tag 拼的）
//       会对不上，报的是「缺 clip9-cli-…」—— 而真正的错在另一个 job 里。
{
  const label = '四个打包 job 都拿 info 的 tag 拼产物名（少了 needs，tag 会渲染成空串）';
  const problems = [];
  if (release === null) {
    problems.push('读不到 release.yml');
  } else {
    for (const job of ['linux', 'macos', 'windows', 'desktop']) {
      const body = jobBlock(release, job);
      if (body === null) {
        problems.push(`读不到 ${job} job`);
        continue;
      }
      const needs = jobNeeds(release, job);
      if (!needs.includes('info')) {
        problems.push(`${job} 的 needs 里没有 info（读到的是 ${JSON.stringify(needs)}）`);
      }
      if (!body.includes('needs.info.outputs.tag')) {
        problems.push(`${job} 里没有拿 needs.info.outputs.tag 拼产物名`);
      }
    }
    // ⚠️ `assets` 那份期望清单必须**同源**：它也按 `needs.info.outputs.tag` 拼。
    //    两边各自写死一个版本号的话，只会在发布时对不上。
    const assets = jobBlock(release, 'assets');
    if (assets === null) {
      problems.push('读不到 assets job');
    } else {
      if (!jobNeeds(release, 'assets').includes('info')) {
        problems.push('assets 的 needs 里没有 info —— 它的期望清单是拿 tag 拼的，会渲染成空串');
      }
      if (!assets.includes('needs.info.outputs.tag')) {
        problems.push('assets 的期望清单没有拿 needs.info.outputs.tag 拼（它必须与打包处同源）');
      }
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(`${label} —— linux/macos/windows/desktop + assets`);
}

// ── 判据 1e：Release 正文从 CHANGELOG 自动抽（`release-notes` job）────────────
//
// ⚠️★ 2026-09-29 加的（Jonny：「以后发版 release 会是中文介绍吗」）。判四件事：
//    ① `release-notes` job 存在，且 `needs` 里**有 publish** —— 那是「排在发布之后」的
//       **全部**依据（GitHub 里顺序就是 needs，没有第二个机制）；
//    ② 它调的确实是 `tools/release-notes.mjs`；
//    ③ 它**真把正文写上去**（`gh release edit … --notes-file`）；
//    ④ 反向：`release.yml` 里**没有**任何 `body` / `body_path` —— 有的话就与③打架，
//       而谁赢取决于 job 谁后跑（**没有症状的那类错**）。
{
  const label = 'release-notes：正文从 CHANGELOG 抽（needs 里有 publish，且没人另设 body）';
  const problems = [];
  if (release === null) {
    problems.push('读不到 release.yml');
  } else {
    const body = jobBlock(release, 'release-notes');
    if (body === null) {
      problems.push('没有 release-notes job —— Release 正文会退回「建的时候手贴」');
    } else {
      const needs = jobNeeds(release, 'release-notes');
      if (!needs.includes('publish')) {
        problems.push(
          `release-notes 的 needs 里没有 publish（读到的是 ${JSON.stringify(needs)}）—— ` +
            '那它可能在资产传上去之前就跑',
        );
      }
      if (!body.includes('tools/release-notes.mjs')) {
        problems.push('release-notes 里没有调 tools/release-notes.mjs');
      }
      if (!/gh release edit[^\n]*--notes-file/.test(body)) {
        problems.push('release-notes 里没有 `gh release edit … --notes-file`（那样正文写不上去）');
      }
    }
    // ④ 反向。⚠️ 只认**键**（`body:` / `body_path:`），不认散文里出现「body」几个字母。
    // ⚠️★ 这里**不能**写成 `^\s+body(_path)?:\s*$` —— 那样只认「空值的 body:」，
    //    而真写正文时后面当然跟着内容（`body: 这次…` / `body: |`），于是**变异验证里
    //    这条判据漏掉了**（第一次就是这么写的，N5 没打红才发现的）。
    const bodyKey = /^ +body(_path)?:/m.exec(release);
    if (bodyKey) {
      problems.push(
        `release.yml 里有 ${JSON.stringify(bodyKey[0].trim())} —— 它与 release-notes 都在写正文，` +
          '谁赢取决于 job 谁后跑（没有症状）。要么删掉它，要么删掉 release-notes。',
      );
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(`${label} —— needs: [info, publish]`);
}

// ── 判据 1f：抽正文那个脚本自己的行为（夹具，四种情形）──────────────────────
//
// ⚠️★ 2026-09-29 加的。`tools/release-notes.mjs` 是**纯的**（读文件 → 打 stdout），
//    所以这里能直接拿夹具喂它 —— 一条真跑得起来的判据，比「检查这个文件存在」强得多。
//    ⚠️★ 夹具里预发布那一条**故意排在正式版上面**：那是「前缀陷阱」最容易露头的排法
//    （`v0.1.0` 的正则要是少了尾巴那个否定断言，就会先命中 `## v0.1.0-beta1`，
//    抽出来的是 beta 的说明 —— 而它在页面上看着**完全正常**）。
//    ⚠️ 另外三种是**必须红**的：版本不存在、那一段是占位、那一段只有标题没有正文。
//    只判「正常情形抽得对」的话，一个永远返回空的脚本也能过。
{
  const label = 'tools/release-notes.mjs：抽对那一段；缺席 / 占位 / 空正文都要报错';
  const problems = [];
  const script = join(ROOT, 'tools/release-notes.mjs');
  if (!existsSync(script)) {
    problems.push('没有 tools/release-notes.mjs');
  } else {
    // ⚠️ 夹具放临时目录，不进仓库（与其它判据的夹具同一个地方）。
    const dir = join(tmpdir(), 'clip9-release-notes-fixture');
    mkdirSync(dir, { recursive: true });

    const write = (name, lines) => {
      const path = join(dir, name);
      writeFileSync(path, lines.join('\n'));
      return path;
    };
    const run = (tag, file) =>
      spawnSync(process.execPath, [script, '--tag', tag, '--changelog', file], {
        encoding: 'utf8',
      });

    const main = write('CHANGELOG.md', [
      '# 更新日志',
      '',
      '## v0.1.0-beta1 · 2026-09-28',
      '',
      '这条是 beta1 的正文，抽 v0.1.0 时**不该**拿到它。',
      '',
      '## v0.1.0 · 2026-09-29',
      '',
      '### 这一版有什么',
      '',
      '就是这一版要说的话。',
      '',
      '## v0.0.9 · 2026-09-27',
      '',
      '再往前那一版的正文。',
      '',
    ]);

    const good = run('v0.1.0', main);
    if (good.status !== 0) {
      problems.push(`抽 v0.1.0 应当成功，却 exit=${good.status}：${good.stderr.trim()}`);
    } else {
      const out = good.stdout;
      if (!out.includes('就是这一版要说的话')) problems.push('v0.1.0 那段正文没抽出来');
      if (out.includes('beta1 的正文')) {
        problems.push('把 `## v0.1.0-beta1` 那段当成 v0.1.0 抽出来了（标题正则少了尾巴的否定断言）');
      }
      if (out.includes('再往前那一版的正文')) problems.push('抽过头了：把下一条 `## ` 之后的正文也带上了');
      if (/^##\s/m.test(out)) problems.push('输出里带上了 `## ` 标题行（应当去掉）');
    }

    // ⚠️ 配对的反面。⚠️ 同时判 stdout：失败时**一个字都不该**打出来 —— 否则
    //    `> notes.md` 会把正文覆盖成那个空/残的东西。
    const missing = run('v0.3.0', main);
    if (missing.status === 0) problems.push('抽一个**不存在**的版本居然成功了（应当报错）');
    if (missing.stdout.trim() !== '') problems.push('失败时往 stdout 写了东西');

    const ph = write('PLACEHOLDER.md', ['## v0.4.0 · 2026-10-01', '', '（变动留空 —— 还没写。）', '']);
    if (run('v0.4.0', ph).status === 0) problems.push('抽到**占位**（「变动留空」）居然成功了');

    const empty = write('EMPTY.md', ['## v0.5.0 · 2026-10-02', '', '## v0.4.0 · 2026-10-01', '']);
    if (run('v0.5.0', empty).status === 0) {
      problems.push('抽到**只有标题、没有正文**的一条居然成功了');
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(label);
}

// ── 判据 2：矩阵条目数 ↔ release.yml 里写死的期望个数 ──────────────────────
//
// ⚠️★ 这条判的是**两边一致**，判据里**不自己存一份数字**（存一份就是又一处会漂的地方）：
//    左边从 `openwrt.yml` 的矩阵数出来，右边从 `release.yml` 的 shell 里数出来。
{
  const label = 'openwrt.yml 的矩阵条目数 ↔ release.yml 里那句 [ "$n_ipk" = N ]';
  const problems = [];
  if (openwrt === null || release === null) problems.push('读不到文件');
  else {
    const ipkBody = jobBlock(openwrt, 'ipk');
    const apkBody = jobBlock(openwrt, 'apk');
    const luciBody = jobBlock(openwrt, 'luci');
    const pw = jobBlock(release, 'publish-openwrt');
    if (ipkBody === null || apkBody === null || luciBody === null || pw === null) {
      problems.push('openwrt.yml 的 ipk / apk / luci 或 release.yml 的 publish-openwrt 读不到');
    } else {
      const ipkN = listLen(ipkBody, 'arch');
      const apkN = listLen(apkBody, 'include');
      // ⚠️ LuCI 那两个包写在 upload 的 `path: |` **块标量**里（一行一个路径，**不带** `- `）——
      //    第一版按 `- ` 找，于是数出 0 条。
      const luciPaths = luciBody.match(/^[ \t]+openwrt\/build\/\S+$/gm) || [];
      const expect = {};
      for (const m of pw.matchAll(/\[ "\$n_(ipk|apk|luci)" = (\d+) \]/g)) expect[m[1]] = Number(m[2]);
      if (ipkN === null || apkN === null) {
        problems.push('openwrt.yml 的 ipk(arch) / apk(include) 两个矩阵读不出来');
      } else if (!('ipk' in expect) || !('apk' in expect) || !('luci' in expect)) {
        problems.push('release.yml 里那三句个数判据读不出来（被改写过了？）');
      } else if (luciPaths.length === 0) {
        problems.push('release.yml 的 luci 的 upload path 一条都没读出来（被改写过了？）');
      } else {
        if (ipkN !== expect.ipk) problems.push(`ipk 矩阵 ${ipkN} 格，release.yml 期望 ${expect.ipk}`);
        if (apkN !== expect.apk) problems.push(`apk 矩阵 ${apkN} 格，release.yml 期望 ${expect.apk}`);
        if (luciPaths.length !== expect.luci) {
          problems.push(`luci 的 upload path ${luciPaths.length} 条，release.yml 期望 ${expect.luci}`);
        }
      }
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(label);
}

// ── 判据 2b：android 的包数 = `splits.abi.include` 的 ABI 数 + 1（合并包）────
//
// ⚠️ 这条的两半各在一处：`release.yml` 的 `publish-android` 里写死了**期望个数**，
//    而实际会出几个包由 `android/app/build.gradle.kts` 的 `splits.abi.include` +
//    `isUniversalApk` 决定。⚠️ 期望个数**不在这里存一份**（存了就是又一处会漂的地方）：
//    从 gradle 那处清单数出来，加一。
// ⚠️ 断了的症状：ABI 多一个 / 少一个时，那边只会在**发版那一刻**红（或者更糟 ——
//    `-gt 0` 那种写法下**根本不红**，少一个包也照发）。
{
  const label = 'android 的包数 ↔ release.yml 里那句 [ "$n" = N ]';
  const problems = [];
  const pa = release === null ? null : jobBlock(release, 'publish-android');
  let abis = null;
  if (pa === null || gradle === null) {
    problems.push('读不到 release.yml 的 publish-android 或 android/app/build.gradle.kts');
  } else {
    const code = gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const filters = /splits\s*\{[\s\S]*?\babi\s*\{[\s\S]*?\binclude\(([^)]*)\)/.exec(code);
    abis = filters ? [...filters[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
    // ⚠️ 只看 `publish-android` 这个 job 块里的那一句 —— `publish-openwrt` 里也有同形状的
    //    判据（`[ "$n_ipk" = 7 ]` 那些），变量名不同，但别把范围放大到整个文件。
    const want = /\[ "\$n" = (\d+) \]/.exec(pa);
    if (!abis || !abis.length) problems.push('读不到 gradle 的 splits.abi.include');
    else if (!want) problems.push('读不到 publish-android 里那句 `[ "$n" = N ]`（被改写过了？）');
    else if (Number(want[1]) !== abis.length + 1) {
      problems.push(
        `ABI 有 ${abis.length} 个（${abis.join('/')}），加上合并包应当期望 ${abis.length + 1} 个，` +
          `而 release.yml 的 publish-android 写的是 ${want[1]}`,
      );
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(`${label} —— ${abis.length} 个 ABI + 1 个合并包 = ${abis.length + 1}`);
}

// ── 判据 3：`assets` **不能** needs openwrt / android ─────────────────────
//
// ⚠️★ 这是**刻意**的：`assets` 是 `publish` 的前置，把它俩加进 needs 之后，
//    缺一个签名 secret 就会让整次发布停在 `assets` —— cli / desktop 也发不出去。
//    「顺手加进去看起来更整齐」，所以要有东西拦着。
{
  const label = 'assets 的 needs 里没有 openwrt / android（它们只排在 publish 之后）';
  const needs = release === null ? null : jobNeeds(release, 'assets');
  if (needs === null) fail(label, `读不到 ${RELEASE} 的 assets 的 needs`);
  else {
    const bad = needs.filter((n) => n === 'openwrt' || n === 'android');
    if (bad.length) {
      fail(label, `assets 的 needs 里有 ${bad.join('、')} —— 它们红了会把 publish 一起卡住`);
    } else if (!needs.includes('linux') || !needs.includes('desktop')) {
      // 对照：needs 读成了空数组也不能算过（那说明解析坏了，不是「真的没有」）。
      fail(label, `assets 的 needs 读出来是 ${JSON.stringify(needs)} —— 解析不可信`);
    } else {
      ok(`${label} —— ${needs.join('/')}`);
    }
  }
}

// ── 判据 4：两个可复用工作流「被调用时不上传」 + 都有手动入口 ───────────────
//
// ⚠️★ 少了 `github.event_name == 'workflow_dispatch'` 那道判断：被 release.yml 调用时
//    `inputs.tag` 同样是填了的，于是**同一个 Release 会被两处同时覆盖上传**。
{
  const label = '两个工作流的 release job 只在 workflow_dispatch 时上传，且都有手动入口';
  const problems = [];
  for (const [file, text] of [
    [OPENWRT, openwrt],
    [ANDROID, android],
  ]) {
    if (text === null) {
      problems.push(`读不到 ${file}`);
      continue;
    }
    if (!/^ {2}workflow_dispatch:/m.test(text)) problems.push(`${file} 没有 workflow_dispatch 入口（要能单独手动跑）`);
    if (!/^ {2}workflow_call:/m.test(text)) problems.push(`${file} 没有 workflow_call 入口（release.yml 要能调它）`);
    const body = jobBlock(text, 'release');
    if (body === null) {
      problems.push(`${file} 里读不到 release job`);
      continue;
    }
    const cond = /^ {4}if: (.+)$/m.exec(body);
    if (!cond) problems.push(`${file} 的 release job 没有 if: —— 被调用时也会上传`);
    else if (!cond[1].includes("workflow_dispatch")) {
      problems.push(`${file} 的 release job 的 if 里没有 workflow_dispatch：${cond[1]}`);
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(label);
}

// ── 判据 5：`splits.abi.include` 的每个 ABI 都在 `rust-toolchain.toml` 里备好了 target ──
//
// ⚠️★ 少一个的症状：`tools/build-android.sh` **跳过**那个 ABI（不报错），
//    而 Gradle 照样编出一个缺那个原生库的包。CI 那边靠 `--require-all` 兜，
//    但「该不该有那个 target」这件事只有这里判。
// ⚠️ abi → target 的映射**不在这里抄**：从 `tools/sync-android-jni-libs.mjs` 的 TARGETS 取。
// ⚠️★ 2026-09-29：ABI 清单的出处从 `abiFilters` 改成了 `splits.abi.include`（拆包那次改动）。
//    所以这里要先**把注释剔掉**再解析 —— 新的 `build.gradle.kts` 注释里就写着反例
//    `splits { abi { … } }`，拿全文去匹配会捞到注释里的 `...`
//    （`tools/android-contract-smoke.mjs` 里那个取清单的函数第一版正是这么错的）。
{
  const label = 'splits.abi.include 的每个 ABI 在 rust-toolchain.toml 里都有对应 target';
  const problems = [];
  if (gradle === null || syncJs === null || toolchain === null) {
    problems.push('读不到 gradle / sync 脚本 / rust-toolchain.toml 之一');
  } else {
    const code = gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const filters = /splits\s*\{[\s\S]*?\babi\s*\{[\s\S]*?\binclude\(([^)]*)\)/.exec(code);
    const abis = filters ? [...filters[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
    const body = /const TARGETS = \[([\s\S]*?)\n\];/.exec(syncJs);
    const rows = body ? [...body[1].matchAll(/\{\s*target:\s*'([^']+)',\s*abi:\s*'([^']+)'/g)] : [];
    // ⚠️ 条目数必须等于 `{` 的个数 —— 否则就是**静默少解析了几条**。
    if (!abis || !abis.length) problems.push('读不到 gradle 的 splits.abi.include');
    else if (!rows.length || rows.length !== ((body?.[1].match(/\{/g) || []).length)) {
      problems.push('sync 脚本的 TARGETS 读不全（条目数与花括号个数对不上）');
    } else {
      const abiToTarget = new Map(rows.map((m) => [m[2], m[1]]));
      const tlist = /targets = \[([\s\S]*?)\]/.exec(toolchain);
      const targets = tlist ? [...tlist[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
      if (!targets || !targets.length) {
        problems.push('读不到 rust-toolchain.toml 的 targets');
      } else {
        for (const abi of abis) {
          const t = abiToTarget.get(abi);
          if (!t) problems.push(`splits.abi.include 里的 ${abi} 在 sync 脚本的 TARGETS 里没有对应 target`);
          else if (!targets.includes(t)) {
            problems.push(`splits.abi.include 里的 ${abi} 要 target ${t}，而 rust-toolchain.toml 的 targets 里没有它`);
          }
        }
        if (problems.length === 0) {
          ok(`${label} —— ${abis.length} 个：${abis.join('/')}`);
        }
      }
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
}

// ── 判据 6：android.yml 那条 `--require-all` 还在 ──────────────────────────
//
// ⚠️★ 去掉它，CI 上「某个 target 没装」就会**静默**走过 —— 出的是缺原生库的包。
{
  const label = 'android.yml 调 build-android.sh 时带了 --require-all';
  if (android === null) fail(label, `读不到 ${ANDROID}`);
  else if (/build-android\.sh[^\n]*--require-all/.test(android)) ok(label);
  else fail(label, '那条命令里没有 --require-all（关掉它 = 允许静默出一个缺 ABI 的包）');
}

// ── 判据 7：release.yml 把 tag 传给了两个可复用工作流 ─────────────────────
//
// ⚠️ 不传的话它们会回落到 `rust/Cargo.toml` 的版本号 —— 包名与 Release 的标签**对不上**，
//    而那种错只有在对资产时才发现。
{
  const label = 'release.yml 把 info 的 tag 传给了 openwrt / android';
  const problems = [];
  if (release === null) problems.push(`读不到 ${RELEASE}`);
  else {
    for (const j of ['openwrt', 'android']) {
      const body = jobBlock(release, j);
      if (body === null) {
        problems.push(`读不到 job ${j}`);
        continue;
      }
      if (!/^ {4}uses: \.\/\.github\/workflows\//m.test(body)) problems.push(`${j} 没有 uses: 调可复用工作流`);
      if (!/^ {4}needs: info$/m.test(body)) problems.push(`${j} 的 needs 不是 info`);
      if (!/tag: \$\{\{ needs\.info\.outputs\.tag \}\}/.test(body)) problems.push(`${j} 没有把 needs.info.outputs.tag 传下去`);
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
  else ok(label);
}

// ── 判据 8：调可复用工作流时，它用到的 secret 真的传过去了 ────────────────
//
// ⚠️★ 可复用工作流**不会**自动拿到调用方的 secret —— 官方规则是「secrets are only passed
//    to directly called workflow」：要么 `secrets:` 显式映射，要么 `secrets: inherit`。
//    少了它，被调文件里那些 `secrets.X` 全是**空串**。
// ⚠️★ 症状**极难认**：被调工作流自己会报「先给这个仓库加上这几个 secret」——
//    看着像「secret 没设」，可 `gh secret list` 里明明都在。2026-09-28 真这样红过一次
//    （`release.yml` 调 `android.yml` 少了 `secrets: inherit`），而**手动 dispatch 是好的**
//    （那时它是顶层工作流、直接读得到仓库 secret）→ 于是更像「只有 release 坏」。
// ⚠️ 这条**不写死**「哪个文件要 secret」：从被调文件里扫 `secrets.*` 现算 ——
//    哪天给 `openwrt.yml` 加一个 secret，这里会先红，而不是等发布。
{
  const label = '调可复用工作流时，它用到的 secret 真的传过去了';
  const problems = [];
  if (release === null) {
    problems.push(`读不到 ${RELEASE}`);
  } else {
    const calls = localWorkflowCalls(release);
    // ⚠️ 自洽检查：解析出的调用点数**必须**等于文件里 `uses: ./.github/workflows/` 的条数。
    //    否则「漏解析了一个调用点」会静默通过 —— 而漏的那个恰恰可能就是要拦的那个。
    const raw = [...release.matchAll(/^ {4}uses: \.\/\.github\/workflows\/\S+/gm)].length;
    if (calls === null || !calls.length) {
      problems.push(`一个 uses: ./.github/workflows/… 的 job 都没解析出来（读不全）`);
    } else if (calls.length !== raw) {
      problems.push(`解析出 ${calls.length} 个调用点，文件里却有 ${raw} 个 —— 解析不可信`);
    } else {
      const passed = [];
      for (const { job, file, secrets } of calls) {
        const text = read(file);
        if (text === null) {
          problems.push(`${job} 调的 ${file} 读不到`);
          continue;
        }
        // ⚠️ `GITHUB_TOKEN` 是**每个工作流都自动有的**，不需要调用方传 → 不算缺口。
        const need = [...new Set([...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].filter(
          (n) => n !== 'GITHUB_TOKEN',
        );
        if (!need.length) continue; // 它一个 secret 都不用 —— 传不传都对
        if (secrets === 'none') {
          problems.push(
            `${job} 调的 ${file} 用了 ${need.join('、')}，但那个 job 里没有 secrets: —— ` +
              `被调工作流里这些值全是空串，它会自己报「secret 没设」（其实设了）`,
          );
        } else if (secrets === 'other') {
          problems.push(`${job} 的 secrets: 后面读不懂（行内 flow mapping？）—— 写成块状或 inherit 才判得准`);
        } else if (secrets === 'map') {
          const body = jobBlock(release, job);
          const missing = need.filter((n) => !new RegExp(`^ {6}${n}: `, 'm').test(body));
          if (missing.length) problems.push(`${job} 的 secrets: 映射里少了 ${missing.join('、')}`);
          else passed.push(`${job}→${file.split('/').pop()}（映射）`);
        } else {
          passed.push(`${job}→${file.split('/').pop()}（inherit）`);
        }
      }
      if (problems.length === 0) {
        // 报出来的「不传」只列**确实一个 secret 都不用**的那些 job（`inherit` 多传是合法的，
        // 不该被说成「故意不传」——那份名单是给人看证据的，说错就白给了）。
        const idle = calls.filter((c) => c.secrets === 'none').map((c) => c.job);
        const tail = idle.length ? `；${idle.join('、')} 不用 secret（故意不传）` : '';
        ok(`${label} —— ${passed.join('、')}${tail}`);
      }
    }
  }
  if (problems.length) fail(label, problems.join('\n    '));
}

// ── 判据 9：openwrt 的 build.sh 给每个 target 单独的 target 目录 ──────────
//
// ⚠️★ 三个 target 串在**同一个 job** 里，而 `cross` 每个 target 用的镜像 glibc 不一样高。
//    **宿主**构建脚本落在共用的 `target/release/` 里 → 在 glibc 高的镜像里编出来、
//    被 glibc 低的镜像直接执行 → `failed to run custom build command for libc …:
//    version `GLIBC_2.28' not found`（exit 101）。**cross-rs/cross#724**，
//    同 issue 里写明 `cargo clean` 不管用，要分开 target 目录。
// ⚠️★ 症状**指不到这里**：报的是某个依赖 crate 的 build script，像代码/依赖问题；
//    而且**换一次顺序就换一个 target 倒**（2026-09-28：x86_64 与 armv7 都过，
//    只挂在第三个 aarch64 上），更像「那个架构有问题」。
// ⚠️★ 这条判据**换过一次形状**，别退回旧的那副 —— 旧的形态**拦不住真出的事**：
//    · 旧形状 = 「`CARGO_TARGET_DIR` 里那截前缀与取产物处拼的前缀**逐字相同**」。
//      2026-09-28 就是它当班时红的：两处**确实同源**，但取产物那处**少拼了一层**
//      `<triple>/`（`--target` 模式下 cargo 在 target 目录里再套一层，产物在
//      `…/$target/$target/release/`）。**同源 ≠ 写对了那一层** —— 比字符串这种形态
//      天生看不见「被比的那一段之外」写错了什么。
//    · 现在的形状 = 「取产物那一步**不许拼路径**，只能引用同一个前缀变量、在它指向的
//      目录里找」。中间有几层根本不写进脚本 → 没得错。⚠️ 刻意不钉「必须用 `find`」
//      这种写法：换成别的机制、只要不写死路径就都算合格。
//
// ⚠️ 那次红得**极具欺骗性**：cross 明明编完了、`Finished release profile
//    [optimized] target(s) in 1m 57s` 也打出来了，紧接着报「找不到产物」。我第一反应
//    是「cross 没把产物挂载回宿主」，**那是错的** —— cross 无条件把宿主 target 挂到
//    容器 `/target`（`src/docker/local.rs` 里就一句 `-v {host_target}:/target`），
//    产物一直在宿主上，只是路径里多一层 `<triple>`。
{
  const label = 'openwrt 的 build.sh 给每个 target 单独的 target 目录（且取产物处不拼路径）';
  const problems = [];
  if (buildSh === null) {
    problems.push('读不到 openwrt/scripts/build.sh');
  } else {
    // ⚠️ 只看**代码行**，注释先剔掉：这段注释里专门写了各种「反面写法」当例子
    //    （比如少一层 `<triple>` 的那个路径），拿全文去匹配会把例子当成真代码 ——
    //    实测就是它把这条判据打红的（判据本身对了，扫到了注释）。
    const code = buildSh
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    // ⚠️ `CARGO_TARGET_DIR` 前面必须**不是标识符字符**：不锚边界的话，
    //    `X_CARGO_TARGET_DIR="…"` 这种「换个名字等于没设」的写法会被当成命中
    //    （变异验证抓到过 —— 判据本来在这条上是瞎的）。
    // ⚠️ 而且前缀必须是**具名变量**：内联路径（`="$RUST_DIR/target/cross-$target"`）功能上
    //    一样对，但第 4 步就没有同一个变量可引用、只能再写一份 —— 那正是旧形状的毛病。
    const ctd = /(?<![A-Za-z0-9_])CARGO_TARGET_DIR="\$([A-Za-z_][A-Za-z0-9_]*)\$target"/m.exec(code);
    if (!ctd) {
      problems.push(
        '没找到 `CARGO_TARGET_DIR="$<变量>$target"` —— 三个 target 共用 target/ 时，宿主构建' +
          '脚本会跨镜像复用，第二个 target 起就报 GLIBC not found（cross#724）；' +
          '而且前缀得是**具名变量**，第 4 步才能引用同一个（否则就是各写一份）',
      );
    }
    // 取产物那一步：⚠️ 只认 `src=` 这个变量名 —— 它同时是后面 `cp` 的输入；
    //    改了名字这里会红（提示跟着代码改），而不是静默放过。
    const srcLines = [...code.matchAll(/^[ \t]*src=(.+)$/gm)].map((m) => m[1].trim());
    if (srcLines.length !== 1) {
      problems.push('取产物那一步（src=）有 ' + srcLines.length + ' 处 —— 应当只有 1 处');
    } else {
      const srcLine = srcLines[0];
      // ⚠️★ **先判这一条**：它才是真出过事的形状，说的也最具体（写死路径 / 少一层）。
      //    把 `release/clip9-server` 拼进路径就是少一层来的 —— `--target` 模式下 cargo 会在
      //    target 目录里**再套一层** `<triple>/`。
      //    ⚠️ 连「写对了两层」的那种也一起拦下：`find` 已经不猜层数了，没理由再退回写死 ——
      //    写死就意味着「层数」这件事又回到了脚本里，下次还得靠人记着。
      if (/release\/clip9-server/.test(srcLine)) {
        problems.push(
          '取产物那一步把路径写死了：' + srcLine + '\n' +
            '    别数那几层 —— 2026-09-28 就是数错一层红的（cross 编完了、`Finished release' +
            ' profile` 也打出来了，紧接着报「找不到产物」）。改成在该 target 的目录里找。',
        );
      }
      // 再判「两处是不是同一个变量」。
      if (ctd && !srcLine.includes('"$' + ctd[1] + '$target"')) {
        problems.push(
          '取产物那一步没有以 "$' + ctd[1] + '$target" 为根（CARGO_TARGET_DIR 用的正是 $' +
            ctd[1] + '）—— 两处各写一份的话，改了其中一处就会去别的地方找二进制',
        );
      }
    }
    if (!problems.length) ok(label + ' —— src= 在 "$' + ctd[1] + '$target" 里找');
  }
  if (problems.length) fail(label, problems.join('\n    '));
}

// ── 判据 10：发版在 main 上留一条版本标记（空提交，不改任何文件）────────────
//
// ⚠️★ 为什么要它：`record-version` 是**漏了也不报错**的那一类 —— 没有它，发布照样全绿、
//    资产照样传上去，只是 `git log` 里一条版本信息都没有。Jonny 2026-09-30 就是这么发现的
//    （「我发版,git记录为什么没有版本信息,类似 `bump version` 这样」）—— clip9 移植发布
//    流程时漏了这个 job（Go 版 `cloud-clipboard-go` 的 `record-version` 从 v5.1.0 起就在跑）。
//
// ⚠️★ 第二件事：这条记录**不许改文件**。版本号的唯一权威是 **tag 本身**（`CHANGELOG.md`
//    抬头那条）；往仓库里再写一份就有两个真值，而那类漂移**只在发布那天才响**
//    （平时两份数并排躺着、谁也不报错）。所以判的是「空提交」这个形状。
//
// ⚠️★ 第三件事：判重**必须是整行相等**，而且**不走 `grep -q`**。这是两个都发生过的坑：
//    ① 用 `git log --grep` 是**子串**匹配 —— `chore(release): v0.1.0` 会撞上
//       `chore(release): v0.1.0-beta4`，于是 beta 先发之后**正式版的记录被吞掉**
//       （而「beta 先、正式版后」正是本仓库的常规顺序，这一撞是必然的）；
//    ② `| grep -q` 一命中就退出 → 上游 `git log` 吃 SIGPIPE → `set -euo pipefail` 下
//       **匹配成功也判成失败** → 每次重跑多堆一条（Go 版 v5.1.0 就因此出现了**两条**，
//       那边用 `fix(release): stop the version marker duplicating on re-run` 修的）。
//    正确形状是 `git log --format=%s | grep -Fx -- "<整行>"`（`-Fx` = 整行字面，无 `-q`）。
//
// ⚠️★ 扫之前**先剥注释**：这个 job 的注释里**刻意举了 `grep -q` 这个反例**，
//    不剥就会把注释当成代码 → 判据永远红（LESSONS 一：扫全文的判据会把注释里的示例当数据）。
{
  const label = '判据 10：record-version 在 main 上留版本标记（空提交 · 不改文件 · 判重不走管道）';
  const raw = jobBlock(release, 'record-version');
  const problems = [];
  if (raw === null) {
    problems.push(
      'release.yml 里没有 `record-version` job —— 发完版 `git log` 里看不到任何版本信息。\n' +
        '    Go 版（父仓库 cloud-clipboard-go）有这个 job，clip9 移植发布流程时漏了。',
    );
  } else {
    // 剥注释：只留 `#` 不占行首的整行（YAML 与 `run: |` 里的 shell 注释一并剥掉）。
    const body = raw
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const needs = jobNeeds(release, 'record-version');
    if (needs === null || !needs.includes('publish')) {
      problems.push(
        `needs 里没有 \`publish\`（读到的是 ${JSON.stringify(needs)}）—— 记录要排在资产传完之后`,
      );
    }
    if (!/git commit --allow-empty -m "chore\(release\): [^"]+"/.test(body)) {
      problems.push(
        '提交不是 `git commit --allow-empty -m "chore(release): <tag>"` 这个形状。\n' +
          '    `--allow-empty` 是**必须**的：它保证这条记录**不改任何文件** —— 改了就等于往\n' +
          '    仓库里放了第二份版本号，那种漂移只在发布那天才响。',
      );
    }
    if (/git add /.test(body)) {
      problems.push('job 里出现了 `git add` —— 这条记录不允许改任何文件（版本号只认 tag）');
    }
    if (/grep -q/.test(body)) {
      problems.push(
        '判重用了 `grep -q` —— 在 `set -euo pipefail` 下 SIGPIPE 会把「匹配成功」判成失败，\n' +
          '    于是每次重跑都多堆一条记录（Go 版 v5.1.0 就因此出现了两条）。用不带 `-q` 的 `grep`。',
      );
    }
    if (/--grep/.test(body)) {
      problems.push(
        '判重用了 `git log --grep` —— 那是**子串**匹配：`chore(release): v0.1.0` 会撞上\n' +
          '    `chore(release): v0.1.0-beta4`，于是 beta 先发之后**正式版的记录被吞掉**\n' +
          '    （「beta 先、正式版后」正是本仓库的常规顺序）。要整行相等。',
      );
    }
    // 整行相等两种写法都认（不必钉死一种形状）。
    const exactLine =
      /grep -Fx/.test(body) ||
      /\[\s*"\$[A-Za-z_]\w*"\s*=\s*"chore\(release\): /.test(body);
    if (!exactLine) {
      problems.push(
        '判重看不出「整行相等」的形状（既没有 `grep -Fx`，也没有 `[ "$x" = "chore(release): …" ]`）\n' +
          '    —— 子串匹配会让正式版撞上同名 beta 那条记录。',
      );
    }
    if (!problems.length) ok(label);
  }
  if (problems.length) fail(label, problems.join('\n    '));
}

// ── 输出 ────────────────────────────────────────────────────────────────────

if (failures.length) {
  console.log('');
  for (const { label, detail } of failures) {
    console.error(`✗ ${label}\n    ${detail}`);
  }
  console.error(`\n✗ ${failures.length} 条判据没过。`);
  process.exit(1);
}
console.log(`\n✓ 工作流之间的跨文件约定自检通过（${okCount} 条判据）。`);
