#!/usr/bin/env node
// shell 脚本里的「变量后面紧跟全角字符」+「run 块里的裸反引号」自检。
//
// 用法：
//   node tools/shell-smoke.mjs                  # 扫仓库
//   node tools/shell-smoke.mjs --root /tmp/xxx  # 扫另一棵树（变异验证用夹具）
//
// ── 为什么要它（判据 1）──────────────────────────────────────────────────────
//
// bash 的变量名里**允许非 ASCII 字符**，而它扫描变量名时不会在中途停下：
// `echo "$abi："` 里的变量名是 `abi：`（带着那个全角冒号），不是 `abi`。
// 于是：
//
//   · 脚本开了 `set -u` → 报 `abi：: unbound variable`（报出来的名字里带着那个
//     全角字节，读起来像乱码），**整条命令挂掉**；
//   · 没开 `set -u` → 变量展开成空字符串，于是那句消息里**恰好少了最要紧的那一截**
//     （版本号、路径），而脚本照常往下走。**这才是更坏的那种。**
//
// 2026-09-28 一次全仓扫描抓到 9 处（`build-android.sh` 4 处、`cloudflare/deploy.sh`、
// `openwrt/scripts/package-openwrt{,-apk}.sh`、`shortcuts/apple/build.sh` 5 处），
// 其中 2 处会崩、3 处静默。它们是**写的时候看不错**的那类 —— `$abi` 与 `${abi}` 在
// 编辑器里长得几乎一样，而中文标点正是这个仓库的默认写法。
//
// ── 判据（会失败）────────────────────────────────────────────────────────────
//
//   1. `*.sh` / `*.yml` 的**代码行**里，`$var` 紧跟一个非 ASCII 字符。
//   2. 一个 `*.sh` 都没扫到 —— 参考物不在时报绿是这个仓库最不想要的那种绿
//      （目录改名、脚本被挪走都会走到这里）。
//   3. `*.yml` 的 `run:` 块里有反引号 —— 它在双引号里是**命令替换**。
//      ⚠️★ 加它的理由：**`bash -n` 看不见这个错**（bash 把替换体的解析推迟到展开时，
//      所以那个块能过语法检查，只有真跑起来才炸）。
//      2026-10-13 发 v0.1.5 时真踩了：`assets` 作业的期望清单里加了一行说明，
//      里面用反引号括了个例子 → 命令替换 → 里面的 `<` 被当重定向 → 语法错 →
//      `assets` 红 → `publish` 被跳过 → **Release 上一个资产都没有**。
//
// ── 只提示、不失败 ───────────────────────────────────────────────────────────
//
//   · `*.sh` 没有 `set -euo pipefail`。写不写是脚本自己的事（第 2 条判据就够了），
//     但它在很大程度上决定了上面那种错是「崩」还是「静默」。
//
// ── 已知的边界（不装作能兜住）────────────────────────────────────────────────
//
//   · **整行注释会被跳过**：注释不展开变量，而且这个规则本身的说明就写在注释里
//     （`$who）` 这种例子必然出现），扫进去只会让人把判据删掉。
//     代价：行尾的内联注释（`echo x  # $v，`）也不看。但那不展开，无所谓。
//   · **单引号里的不算**：`'$HOME/文档'` 不展开，写出来就是要它字面。
//   · 不做真正的 shell 词法分析：一行里的单引号个数为奇数就认为命中处在单引号内。
//     那行本来就是坏的 shell，怎么判都不重要。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
if (rootFlag >= 0 && !args[rootFlag + 1]) {
  console.error('✗ --root 后面要跟一个目录');
  process.exit(2);
}
const ROOT = rootFlag >= 0 ? resolve(args[rootFlag + 1]) : resolve(HERE, '..');

/** 这些目录里的东西不是「我们写的脚本」：构建产物、依赖、缓存。 */
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', '.git', '.gradle', 'build', 'outputs', '.workbuddy', '.venv',
]);

const SHELL_EXT = new Set(['.sh']);
const YAML_EXT = new Set(['.yml', '.yaml']);

/** `$var` 后面紧跟一个非 ASCII 字节。⚠️ `\$` 不算（那是转义，本来就要字面）。 */
const SUSPECT = /(?<!\\)\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;

/**
 * 一个 shell/YAML 文件里 heredoc **体**覆盖的行号（1 起）。
 *
 * ⚠️★ 判据 3 必须跳过它们：heredoc 体里通常是**别的语言**（Rust / Python / YAML），
 * 那里的反引号是那种语言的语法，不是 bash 的命令替换。
 * 实测的两个例子：`deploy-cloudflare.yml` 里那段写 `GITHUB_STEP_SUMMARY` 的 Python、
 * `wasm-spike.yml` 里那段现写出来的 Rust 探针（`<<'RS'`）。
 * 不跳的话这条判据一上来就误报 2 处 —— 而**误报的判据活不过第二天**。
 */
function heredocBodyLines(lines) {
  const out = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    if (!m) continue;
    const delim = m[2];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === delim) break;
      out.add(j + 1);
    }
  }
  return out;
}

/**
 * 这一行里**没转义**的反引号，有没有落在**双引号**里。
 *
 * ⚠️ 精度就靠这个：单引号里的反引号是**字面量**（正确写法，实测 `release.yml` 里
 * `grep -q 'Falling back to \`cargo\` on the host'` 就是这样），只有双引号里的才是命令替换。
 * ⚠️ 不做真正的词法分析（与判据 1 同一条边界）：数引号个数判奇偶。
 */
function bareTickInsideDoubleQuotes(line) {
  for (const m of line.matchAll(/(?<!\\)`/g)) {
    const before = line.slice(0, m.index);
    if ((before.match(/'/g) || []).length % 2 === 1) continue; // 单引号里 → 字面
    if ((before.match(/"/g) || []).length % 2 === 1) return true; // 双引号里 → 命令替换
  }
  return false;
}
/**
 * 一个 YAML 文件里所有 `run:` 块覆盖的行号（1 起，含块体）。
 *
 * ⚠️★ 为判据 3 服务。**为什么需要它**：反引号在 `run:` 块里是命令替换，
 * 而在 YAML 的 `name:` / `description:` 里只是普通字符 —— 不区分就会误报。
 * ⚠️ 单行 `run: echo x` 也要算上：它没有多行体，但那一行里反引号一样会展开。
 */
function runBlockLines(lines) {
  const inRun = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const block = /^(\s*)(?:- )?run:\s*[|>][-+]?\s*$/.exec(lines[i]);
    if (block) {
      const indent = block[1].length;
      inRun.add(i + 1);
      for (let j = i + 1; j < lines.length; j += 1) {
        const body = lines[j];
        if (body.trim() === '') {
          inRun.add(j + 1);
          continue;
        }
        if (body.length - body.trimStart().length <= indent) break;
        inRun.add(j + 1);
      }
      continue;
    }
    if (/^\s*(?:- )?run:\s*\S/.test(lines[i])) inRun.add(i + 1);
  }
  return inRun;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const failures = [];
const notes = [];
let shellFiles = 0;
let yamlFiles = 0;

for (const file of walk(ROOT)) {
  const ext = extname(file);
  const isShell = SHELL_EXT.has(ext);
  const isYaml = YAML_EXT.has(ext);
  if (!isShell && !isYaml) continue;
  if (isShell) shellFiles += 1;
  else yamlFiles += 1;

  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const runLines = isYaml ? runBlockLines(lines) : null;
  const heredocLines = isYaml ? heredocBodyLines(lines) : null;

  // 判据 2 的一半：`set -euo pipefail`（只提示）。⚠️ 缩成一行 —— 这里是**提示**，
  // 不是待办清单：铺 5 行出来会让人把它当成 5 个「要修的问题」，然后开始无视整段输出。
  if (isShell && !/^set -[a-z]*e[a-z]*u|^set -[a-z]*u[a-z]*e/m.test(text)) {
    notes.push(rel);
  }

  lines.forEach((line, index) => {
    // 整行注释跳过（见文件头「已知的边界」）。
    if (/^\s*#/.test(line)) return;

    // ── 判据 3：workflow 的 `run:` 块里出现反引号 ──────────────────────────
    //
    // ⚠️★ 反引号在**双引号里**是命令替换。真正致命的是：**`bash -n` 看不见这个错** ——
    //    bash 把替换体的解析**推迟到展开时**，所以那个块能过语法检查，
    //    只有真跑起来才炸。
    // ⚠️★ 2026-10-13 真踩了：发 v0.1.5 时 `assets` 作业的期望清单里加了一行说明，
    //    里面用反引号括了个 `-static <目录>` 的例子 → 命令替换 → `<` 被当重定向 →
    //    语法错 → `assets` 红 → `publish` 被跳过 → **Release 上一个资产都没有**。
    //    而本机跑 `bash -n` 全绿（我还专门试过），所以它必须是一条**独立的**判据。
    // ⚠️★ 两个精度条件，缺一个这条判据就活不过第二天（两个都实测误报过）：
    //    · **heredoc 体里不算** —— 那里面是别的语言（Rust / Python），反引号是那种语言的语法；
    //    · 只认**双引号里**的，且**没转义** —— 单引号里是字面量，`\`` 是「就要这个字符」。
    if (
      runLines
      && runLines.has(index + 1)
      && !heredocLines.has(index + 1)
      && bareTickInsideDoubleQuotes(line)
    ) {
      failures.push({
        file: rel,
        line: index + 1,
        text: line.trim(),
        detail:
          '`run:` 块里有反引号 —— 它在双引号里是**命令替换**，而替换体 bash 要到'
          + '展开时才解析，所以 `bash -n` 看不见，只有真跑起来才炸。\n'
          + '    要字面反引号就写 \\` 转义，要命令替换就写 $(…)，其余情况直接把反引号去掉。',
      });
    }

    SUSPECT.lastIndex = 0;
    let match;
    while ((match = SUSPECT.exec(line)) !== null) {
      const at = match.index;
      const hit = match[0];
      // 命中处在单引号里 → 不展开，跳过。
      const quotesBefore = (line.slice(0, at).match(/'/g) || []).length;
      if (quotesBefore % 2 === 1) continue;

      const varName = hit.slice(1, -1);
      failures.push({
        file: rel,
        line: index + 1,
        text: line.trim(),
        detail: `\`$${varName}\` 后面紧跟 \`${hit.slice(-1)}\` —— 变量名会被当成 \`${varName}${hit.slice(-1)}\`。`
          + `\n    改成：\`\${${varName}}\`（加花括号），或者把那个全角字符挪开。`,
      });
    }
  });
}

const total = shellFiles + yamlFiles;
console.log(`扫了 ${total} 个文件（${shellFiles} 个 .sh、${yamlFiles} 个 .yml/.yaml）`);

// 判据 2：一个 .sh 都没有 = 扫错地方了，别报绿。
if (shellFiles === 0) {
  console.error(`✗ 一个 .sh 都没扫到（在 ${ROOT} 下）—— 判据没东西可查，不算通过。`);
  process.exit(1);
}

if (notes.length) {
  console.log(`\n提示（不失败）：${notes.length} 个 .sh 没写 set -euo pipefail —— 上面那种写法在它们里会是**静默**的（变量展开成空，消息里少一截）。`);
  console.log(`  ${notes.join('、')}`);
}

if (failures.length) {
  console.error('');
  for (const f of failures) {
    console.error(`✗ ${f.file}:${f.line}`);
    console.error(`    ${f.text}`);
    console.error(`    ${f.detail}`);
  }
  console.error(`\n✗ ${failures.length} 处：全角字符会被算进变量名 / run 块里的反引号是命令替换。`);
  process.exit(1);
}

console.log('\n✓ 没有「变量后面紧跟全角字符」的写法，run 块里也没有裸反引号。');
