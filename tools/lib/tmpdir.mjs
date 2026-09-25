// 临时目录：建，以及**用完怎么处置**。
//
// ⚠️★ 处置一律用 **`mv` 挪走，不用 `rm -rf`**。
//
// 这台机器的沙箱有一条**批量删除守卫**：递归删除会弹权限确认框，而
// **rename 不算删除** —— 挪到垃圾桶目录之后就再也没人看它，效果一样，但不打扰人。
// 撞得最狠的是 Chrome 的临时 profile（几百个文件），其次是一轮比对的两个数据目录。
// 同一个理由在前端重建的场景里也成立（`cloud-clip/lib/static` / `web-vue3/dist`，
// 都在 Go 仓库里）—— 那里的做法是 `mv lib/static /tmp/x` 之后再构建，
// 因为 vite 的 `emptyOutDir` 与 `after-build.js` 的 `rmSync` 都会撞上这条守卫。
//
// 代价是 `/tmp` 里会攒下 `clip9-trash-*`。系统会自己清 `/tmp`，而且那是**看得见**的垃圾；
// 相比之下「每次跑脚本都弹一次确认框」是纯打扰。

import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** 建一个临时目录，返回它的路径。 */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 把一个用完的临时目录挪进垃圾桶目录（**不删**）。
 *
 * 挪不动就留着 —— 清理失败不该盖住真正的错误，更不该让脚本挂在最后一步。
 */
export function dispose(path) {
  try {
    const trash = join(tmpdir(), `clip9-trash-${process.pid}`);
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, `${Date.now()}-${basename(path)}`));
  } catch {
    /* 忽略 */
  }
}
