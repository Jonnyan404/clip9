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

import { readFileSync, existsSync } from 'node:fs';
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
const ok = (label) => console.log(`✓ ${label}`);

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

// ── 判据 5：`abiFilters` 的每个 ABI 都在 `rust-toolchain.toml` 里备好了 target ──
//
// ⚠️★ 少一个的症状：`tools/build-android.sh` **跳过**那个 ABI（不报错），
//    而 Gradle 照样编出一个缺那个原生库的包。CI 那边靠 `--require-all` 兜，
//    但「该不该有那个 target」这件事只有这里判。
// ⚠️ abi → target 的映射**不在这里抄**：从 `tools/sync-android-jni-libs.mjs` 的 TARGETS 取。
{
  const label = 'abiFilters 的每个 ABI 在 rust-toolchain.toml 里都有对应 target';
  const problems = [];
  if (gradle === null || syncJs === null || toolchain === null) {
    problems.push('读不到 gradle / sync 脚本 / rust-toolchain.toml 之一');
  } else {
    const filters = /abiFilters \+= listOf\(([^)]*)\)/.exec(gradle);
    const abis = filters ? [...filters[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
    const body = /const TARGETS = \[([\s\S]*?)\n\];/.exec(syncJs);
    const rows = body ? [...body[1].matchAll(/\{\s*target:\s*'([^']+)',\s*abi:\s*'([^']+)'/g)] : [];
    // ⚠️ 条目数必须等于 `{` 的个数 —— 否则就是**静默少解析了几条**。
    if (!abis || !abis.length) problems.push('读不到 gradle 的 abiFilters');
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
          if (!t) problems.push(`abiFilters 里的 ${abi} 在 sync 脚本的 TARGETS 里没有对应 target`);
          else if (!targets.includes(t)) {
            problems.push(`abiFilters 里的 ${abi} 要 target ${t}，而 rust-toolchain.toml 的 targets 里没有它`);
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
// ⚠️ 这条判的是「**同一处定义**」：`CARGO_TARGET_DIR` 里那截前缀与第 4 步拼产物路径
//    用的前缀必须逐字相同 —— 两边各写一份的话，改了其中一处就会去别处找二进制。
{
  const label = 'openwrt 的 build.sh 给每个 target 单独的 target 目录（且取产物处同源）';
  const problems = [];
  if (buildSh === null) {
    problems.push('读不到 openwrt/scripts/build.sh');
  } else {
    // ⚠️ 两种写法都认：前缀写成变量（`"$PREFIX$target"`）或直接写在引号里。
    //    这里比较的是**引号里 `$target` 之前的那一截**，所以两种写法比的是同一个东西。
    const ctd = /CARGO_TARGET_DIR="([^"]*)\$target"/.exec(buildSh);
    const src = /^[ \t]*src="([^"]*)\$target\/release\/clip9-server"/m.exec(buildSh);
    if (!ctd) {
      problems.push(
        '没找到 `CARGO_TARGET_DIR="…$target"` —— 三个 target 共用 target/ 时，宿主构建脚本' +
          '会跨镜像复用，第二个 target 起就报 GLIBC not found（cross#724）',
      );
    }
    if (!src) {
      problems.push('没找到 `src="…$target/release/clip9-server"` —— 取产物那一步被改写了？');
    }
    if (ctd && src && ctd[1] !== src[1]) {
      problems.push(
        `target 目录两处不是同一个值：CARGO_TARGET_DIR 那处是 ${JSON.stringify(ctd[1])}，` +
          `取产物那处是 ${JSON.stringify(src[1])}`,
      );
    }
    if (!problems.length) ok(`${label} —— ${JSON.stringify(ctd[1])}<target>`);
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
console.log('\n✓ 工作流之间的跨文件约定自检通过（9 条判据）。');
