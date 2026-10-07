#!/usr/bin/env node
// 把各平台分别生成的 `latest.json` 合并成**一份**。
//
// # ⚠️★ 为什么必须合并
//
// `tauri-action` 在**每个矩阵 job 里各写一份** `latest.json`，而那一份的 `platforms`
// 只含**本平台**那一格。updater 要的是**一份**、里面四格齐全的 ——
// 它按当前平台去那张表里找自己那一格，找不到就当「没有更新」。
//
// 不合并的后果**不是报错**，而是：最后上传的那一份覆盖掉前面的，
// 于是**只有最后那个平台的用户能更新**，另外三个平台永远显示「已是最新」。
// 那种 bug 在 CI 上是绿的，只有用户会发现。
//
// # 用法
//
//   node tools/merge-updater-json.mjs <目录>
//
// 读该目录下的 `clip9-desktop-<tag>-<label>-latest.json`（由 release.yml 的桌面端 job
// 按平台重命名后上传），合并成 `latest.json`，并把那些分片删掉。
//
// ⚠️ 分片名带着 `clip9-desktop-` 前缀是**必须的**：publish job 有一条「待传清单里
// 不许有别的东西」的检查，而它只放行 `clip9-cli-*` 与 `clip9-desktop-*`。

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('✗ 用法：node tools/merge-updater-json.mjs <目录>');
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`✗ 目录不在：${dir}`);
  process.exit(2);
}

const shards = readdirSync(dir)
  .filter((name) => /^clip9-desktop-.+-latest\.json$/.test(name))
  .sort();
if (shards.length === 0) {
  console.error(
    `✗ ${dir} 里没有 clip9-desktop-*-latest.json —— 桌面端那一步没把它们收上来？\n` +
      '  ⚠️ 少了它们的后果：Release 上没有 latest.json，于是**所有平台的自动更新都不工作**\n' +
      '  （而 Releases 页面看起来一切正常）。'
  );
  process.exit(1);
}

let merged = null;
const seen = new Map();
for (const name of shards) {
  const text = readFileSync(join(dir, name), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error(`✗ ${name} 不是合法 JSON：${error.message}`);
    process.exit(1);
  }
  // ⚠️ 版本号必须**四份一致**：不一致说明矩阵里有的 job 用了别的 tag，
  // 那是一种更难查的错（部分平台升到 A、部分升到 B）。
  if (merged && parsed.version !== merged.version) {
    console.error(
      `✗ 版本号对不上：${name} 是 ${parsed.version}，前面那份是 ${merged.version}\n` +
        '  ⚠️ 四份必须是同一个 tag —— 否则「哪些平台能升到哪一版」会变成一件说不清的事。'
    );
    process.exit(1);
  }
  if (!merged) {
    merged = { ...parsed, platforms: {} };
  }
  for (const [target, entry] of Object.entries(parsed.platforms ?? {})) {
    // ⚠️ 同一个 target 出现两次说明两个 job 打了同一个平台 —— 后者覆盖前者是**猜**，
    // 不如直接报错（CI 里两个 job 打同一平台本身就是配置错了）。
    if (seen.has(target)) {
      console.error(`✗ ${target} 出现了两次（${seen.get(target)} 与 ${name}）—— 矩阵配重了？`);
      process.exit(1);
    }
    seen.set(target, name);
    merged.platforms[target] = entry;
  }
}

const targets = Object.keys(merged.platforms).sort();
if (targets.length === 0) {
  console.error('✗ 合并出来一份空的 platforms —— updater 会认为没有任何平台有更新');
  process.exit(1);
}

writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
for (const name of shards) unlinkSync(join(dir, name));

console.log(`✓ 合并 ${shards.length} 份 → latest.json（v${merged.version}，${targets.length} 个平台）`);
for (const target of targets) console.log(`    ${target}  ← ${seen.get(target)}`);
