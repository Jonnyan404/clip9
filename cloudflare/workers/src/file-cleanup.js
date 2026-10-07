// 过期文件清理：把「到期了、但再也没人访问」的文件真正收掉。
//
// 与自建服务端同一件事：Rust 的 `server/src/file_cleanup.rs`（阶段 A/B）、
// Go 的 `cleanExpiredFilesLoop`。周期都是 5 分钟（见 wrangler.toml.template 的 `[triggers]`）。
//
// # ⚠️★ 为什么必须有它
//
// Worker 侧原本**只有请求路径上的惰性清理**（`handlers/file.js` 下载时那一段
// 「文件已过期 → 删 R2 + 404」、`handlers/content.js` 的 `getById` 同理）：
// 有人来 GET 一个已经过期的 uuid，才顺手把字节删掉。
//
// 后果是**没人再访问的过期文件永远留在 R2 里**：
//   · R2 没有对象级 TTL —— 桶里的对象不会自己消失；
//   · D1 那行也不会因为「过期」被删 —— 只有写入侧的**容量裁剪**（超过 HISTORY_LIMIT）
//     才会动它（`utils.js:cleanupOldMessagesBeforeSave`）。
// 于是「传一个有 1 小时有效期的文件，之后再没人碰」 = 字节与条目**都留着**。
//
// Rust 那边实测过同一件事的后果（「传 10 个文件、全部过期、一个都不碰，23 秒后
// 10 个仍在磁盘上」）；这里的形式不同（R2 而不是本地盘），结论一样，只是不会写满盘而已。
//
// # 一轮扫什么（与 Rust 的阶段 A/B 对齐）
//
// | 步骤 | 做什么 |
// |---|---|
// | 1 | 查出 `type='file'` 且 `0 < expireTime < now` 的条目（按 expireTime 升序、LIMIT） |
// | 2 | 先把 R2 字节**批量**删掉 |
// | 3 | 再删 D1 条目（在 Worker 里这一行**同时**是「文件登记」和「时间线条目」） |
// | 4 | 逐条广播 `revoke`，广播到**条目自己记录的** room |
//
// # ⚠️ 为什么没有 Rust 的阶段 C（全库对账）
//
// Rust 阶段 C 要 `list()` 整个文件登记表 + 扫全表：收掉「没人引用的登记」、
// 「引用了不存在文件的条目」，再跑一次全库裁剪。这里的对应物是**列整个 R2 桶**，
// 而 R2 的 `list()` 是**计费操作**、桶大了还慢 —— 塞进一个每 5 分钟的任务里不合适。
//
// 况且「孤儿字节」的窗口本来就窄：写路径已经把要删的 uuid 交回调用方了
// （`saveToD1` 返回 `filesToCleanup`，`handlers/text.js` / `handlers/file.js` 随即删 R2）。
// 真要兜底，应该另起一个**低频**（比如每小时）的 cron，而不是加在这里。
//
// # ⚠️★ 两个必须守住的边界（照 Rust 抄）
//
// 1. **`expireTime = 0` 是「永不过期」**，不是「立刻过期」。SQL 里必须是
//    `expireTime > 0 AND expireTime < ?`，两个条件缺一不可。
//    写错的表现是「设了永不过期的文件被下一轮后台清理**全部清光**」——
//    功能整个失效，而且不报任何错。房间级 `roomAuth[x].fileExpire = 0` 正是走这条路。
// 2. **先删字节、再删条目**（与 Rust 同一个顺序、同一个理由）：反过来最坏是
//    「条目没了、字节还在」= 界面上完全看不到的**孤儿字节**，那是最难查的一类。
//    按这个顺序，R2 删失败时**就不删条目**（下一轮再试）——
//    最坏只是「字节没了、条目还在」，可重试、幂等。
//
// # 与惰性清理的关系
//
// 两者**不冲突、也不必二选一**：惰性清理管「有人来访问的那一个」（响应要快、
// 不能让用户拿到过期字节），这里管「没人访问的那些」（兜底回收）。都保留。

import { broadcastMessage } from './utils';

// 一轮最多处理多少个过期文件。
//
// ⚠️★ 双重上限都要看，取**更紧**的那个：
//
// **① 子请求（免费档 50/次调用）** —— 一轮的子请求 ≈
//     1（SELECT）+ 1（R2 批量删）+ 1（D1 删）+ N（逐条广播）= N + 3。
//     取 40 → 最坏 43，落在 50 之内。
//
// **② CPU（免费档 cron 10 ms/次调用）** —— 实测（2026-10-07，Node + 立即 resolve 的桩 I/O，
//     只量真正计入 CPU 的那部分）：
//       空扫（没有过期文件）            0.005 ms
//       满批 10 / 20 / 40 条+广播   ≈ 1.2 ms（三者几乎一样，单条边际成本很小）
//     —— 纯逻辑便宜到可以忽略。**真正吃 CPU 的是日志**：`console.log` 在 Cloudflare
//     是计 CPU 的，而 `broadcastMessage` 每调一次打一行；40 条带日志时整轮 ≈ 6.8 ms。
//     所以这里传了 `quiet: true`（见下面步骤 4），把那一项消掉。
//
// 40 个 / 5 分钟 = 每小时 480 个，对剪贴板这种量级远超实际水位。
// ⚠️ 想调大：先确认是付费版（子请求 1000、cron CPU 30s），否则 ① 会先炸。
// ⚠️ 一轮跑不完不影响正确性（幂等），只是积压清得慢一点，下一轮继续。
export const FILE_CLEANUP_BATCH = 40;

// 一条 `DELETE ... WHERE id IN (…)` 里最多绑几个 id。
// D1 对绑定参数有上限（100），这里留足余量；批大于它时自动拆成多条。
const D1_DELETE_CHUNK = 40;

/**
 * 后台清理是否开着。
 *
 * 约定与 Rust 的 `server.fileCleanup` **一致**：`<= 0` = 不跑，缺省跑。
 *
 * ⚠️ 两点刻意的取舍：
 *   · **周期不在这里**。Cloudflare 的周期只能由 cron 表达式表达（配置里那一行），
 *     没有「运行时改周期」这一说 —— 所以这个变量只当开关用，值本身只判正负。
 *   · **值写坏了（NaN）时按「跑」处理**。静默停掉清理的方向是「R2 只涨不消」，
 *     而多跑一轮的代价只是一次空扫 —— 两个方向不对称，所以往安全的那边倒。
 */
export function isFileCleanupEnabled(env) {
  const raw = env?.FILE_CLEANUP;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return true;
  }
  const secs = Number(raw);
  if (!Number.isFinite(secs)) {
    return true;
  }
  return secs > 0;
}

/** 把数组按 size 切成若干段（段数 ≥ 1；空数组给不出段）。 */
function chunkOf(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * 跑一轮过期文件清理。
 *
 * @param {object} env             Worker env（要 `DB` 与 `R2_BUCKET`）
 * @param {object} [options]
 * @param {number} [options.now]   当成「现在」的 Unix 秒（测试用；缺省取真实时间）
 * @param {number} [options.limit] 这一轮最多处理几条（测试/运维用；缺省 FILE_CLEANUP_BATCH）
 * @returns {Promise<{expired: number, entries: number, failed: number}>}
 *          字段含义与 Rust 的 `SweepReport` 对齐：
 *          `expired` = 查到的过期文件数，`entries` = 真正删掉的条目数，`failed` = 没收拾掉的行数。
 */
export async function sweepExpiredFiles(env, options = {}) {
  const report = { expired: 0, entries: 0, failed: 0 };

  // 绑定不齐时**安静地什么都不做**：本地 `wrangler dev` 或没配 R2/D1 的部署
  // 不该因为一个后台任务而反复报错。
  if (!env?.DB || !env?.R2_BUCKET) {
    return report;
  }
  if (!isFileCleanupEnabled(env)) {
    return report;
  }

  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : FILE_CLEANUP_BATCH;

  // ── 步骤 1：查出过期的文件条目 ──
  // ⚠️ `expireTime < ?`（严格小于）与读取路径同一条判据（`handlers/file.js` 用的是
  //    `currentTime > expireTime`）—— 正好等于过期时刻的那一秒还不算过期。
  //
  // ⚠️ 这里把 expireTime 当**Unix 秒**比较，与 `handlers/stats.js` 的过滤条件一致。
  //    若历史上有行写成了毫秒（13 位），它会大于 now（10 位）而**永不被选中** ——
  //    方向是「漏清」而不是「误删」，安全。`handlers/content.js:normalizeExpire` 是
  //    读取侧的同类防御，两处不冲突。
  //
  // ⚠️★ 三个条件各自的角色（别以为它们互相冗余 —— 实测删掉哪个都有用例红）：
  //    · `type = 'file'`        —— 挡住文本行（**它是唯一挡住文本的那条**）；
  //    · `uuid IS NOT NULL AND uuid != ''` —— **窄化自己的作用域**：不去删
  //      「认不出来的行」（没有 uuid 的文件行本来也没法下载、点了也没用），
  //      也避免发一次 `files/null` 这种无意义（虽然无害）的 R2 删除。
  //      它是**刻意的窄化**，不是错误；真要连带回收畸形行，那是另一次决定。
  //    · `expireTime > 0 AND expireTime < ?` —— 见文件头的边界 1。
  let rows;
  try {
    const result = await env.DB.prepare(
      `SELECT id, uuid, room FROM messages
        WHERE type = 'file'
          AND uuid IS NOT NULL AND uuid != ''
          AND expireTime > 0 AND expireTime < ?
        ORDER BY expireTime ASC
        LIMIT ?`
    ).bind(now, limit).all();
    rows = result?.results ?? [];
  } catch (error) {
    console.error('查询过期文件失败（下一轮再试）:', error);
    return report;
  }

  report.expired = rows.length;
  if (rows.length === 0) {
    return report;
  }
  if (rows.length >= limit) {
    // 说明还有积压：这一轮把预算用完了，剩下的下一轮继续（幂等，不影响正确性）。
    console.log(`过期文件达到本轮上限 ${limit}，剩余留到下一轮`);
  }

  // ── 步骤 2：先把 R2 字节删掉（批量）──
  // R2 的 `delete()` 收数组时是**一次**调用（单次最多 1000 个 key），比逐个删省得多，
  // 也正是上面那份子请求预算成立的前提。
  // 同一 uuid 可能有多行（同一个文件被重复登记），去重后只删一次。
  const keys = [...new Set(rows.map((row) => `files/${row.uuid}`))];
  try {
    await env.R2_BUCKET.delete(keys);
  } catch (error) {
    // ⚠️★ 这里**故意不往下删条目**：留下条目，下一轮还会再试一次。
    // 反过来（照删不误）就会留下「条目没了、字节还在」的孤儿字节 —— 见文件头的边界 2。
    report.failed = rows.length;
    console.error(`删除 ${keys.length} 个过期文件的 R2 字节失败（条目保留，下一轮再试）:`, error);
    return report;
  }

  // ── 步骤 3：再删 D1 条目 ──
  const ids = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
  const removed = new Set();
  for (const chunk of chunkOf(ids, D1_DELETE_CHUNK)) {
    try {
      await env.DB.prepare(
        `DELETE FROM messages WHERE id IN (${chunk.map(() => '?').join(',')})`
      ).bind(...chunk).run();
      for (const id of chunk) {
        removed.add(id);
      }
    } catch (error) {
      // ⚠️ 删条目失败只记账、不中断：字节已经删了，留着条目下一轮会再走一遍（幂等）。
      report.failed += chunk.length;
      console.error(`删除过期文件的条目失败（下一轮再试）: ids=${chunk.join(',')}`, error);
    }
  }
  report.entries = removed.size;

  // ── 步骤 4：逐条广播 `revoke` ──
  // 不广播的话各端界面上那张卡片不会自己消失，要等下一次刷新/重新拉历史。
  // ⚠️ 广播到**条目自己记录的** room（与 `handle_revoke` 同一条规矩）——
  //    绝不能用「当前房间」或调用方传进来的房间（这个任务根本没有「当前房间」）。
  // ⚠️ `broadcastMessage` 自己吞掉异常（广播失败不该让清理半途而废）。
  // ⚠️★ 传 `quiet: true`：那一行 `Broadcast message to room: …` 在满批时会变成
  //    **40 行**，而 Cloudflare 的 `console.log` 是**计 CPU** 的。实测（见 `utils.js`
  //    里 `broadcastMessage` 的注释）：40 条**带日志** ≈ 6.8ms/轮、**不带** ≈ 1.2ms/轮，
  //    而免费档 cron 的 CPU 上限只有 10ms —— 那 5.5ms 就是这 40 行的账。
  //    这一轮的结论由 `scheduled` 打**一行**汇总，比 40 行同义日志有用。
  for (const row of rows) {
    const id = Number(row.id);
    if (!removed.has(id)) {
      continue;
    }
    await broadcastMessage(env, row.room || 'default', { event: 'revoke', data: { id } }, { quiet: true });
  }

  return report;
}
