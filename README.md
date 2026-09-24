# clip9 —— Rust 重写版（过渡期工作区）

这个目录是 `cloud-clipboard-go` 的 **Rust 重写实现**，按
[`../clip-sync/ARCHITECTURE.md`](../clip-sync/ARCHITECTURE.md) 的 §8 分阶段清单推进。
过渡期它住在这里，**对齐完成、用 Rust 发过一次版之后**再拆成独立仓库。

---

## ⚠️ 这个目录完全本地，不要推到 GitHub

- 父仓库 `.gitignore` 里有一条 `rust/` —— **别删**。删了之后 git 会把它当**嵌套仓库**，
  `git add -A` 有可能把整棵树提交到 `cloud-clipboard-go`（那正是要避免的事）。
- 它自己有一个**没有 remote** 的本地 git 仓库（和隔壁 `clip-sync/` 一个路子）。
  `git remote -v` 应该是空的 —— **推之前先确认这一条**。
- 开发完毕、要拆出去时：直接把这个目录推到一个**新** GitHub 仓库即可
  （历史就是这里的本地历史，不从 `cloud-clipboard-go` 里 `filter-repo` 抽）。
- ⚠️ 契约文档 `../docs/api*.md` **不复制一份过来**，两边都读父仓库那一份 —— 复制必然漂。
  同理，语言无关的行为用例在父仓库 `../cases/`（见下）。

## 目录

```
rust/
├── Cargo.toml               # workspace
├── crates/
│   ├── protocol/            # ★ 契约层：请求/响应/WS 事件的 serde 类型。零 IO
│   ├── core/                # 领域逻辑：房间鉴权、会话令牌、分享 token、模板引擎、cron
│   ├── actions/             # ★ 单一动作库：纯函数、无 IO → 原生 + wasm32
│   ├── store/               # ★ redb 封装：只有这里知道存储长什么样
│   ├── server/              # axum HTTP+WS；lib（可内嵌）+ bin（可独立跑）
│   └── client/              # 剪贴板监控 + 上行 + 下行
└── docs/                    # 这个实现自己的工程笔记（契约权威在 ../docs/api*.md）
```

依赖单向：`protocol ← core ← store ← server ← { bin, client }`，`actions ← core/server/WASM`。

## 用例数据在父仓库

| 位置 | 内容 | 谁读 |
|---|---|---|
| `../cases/protocol/*.json` | 从 Go 导出的 JSON fixture，钉住字段名与形状 | Rust 测试（反序列化断言） |
| `../cases/actions.json` | 动作行为用例（§5.4） | **Go 与 Rust 都读** = 双跑验证 |

⚠️ 这两个文件**属于契约**，所以放在父仓库入库；`rust/` 本身不入库。

## 工具链

rustup 管理（2026-09-25 装，见 `~/.zprofile`）。
⚠️ 本机同时有一份 Homebrew 的 rust，**只有 `x86_64-apple-darwin` 一个 target**；
`~/.zprofile` 里 `. "$HOME/.cargo/env"` 必须排在 `brew shellenv` 之后，`cargo` 才是 rustup 那份。
`rustup target list --installed` 里应该能看到 wasm32 与几个 musl / android 目标。

```bash
cargo build --workspace          # 原生（macOS）开发
cargo test  --workspace
cargo run -p clip9-server        # 起服务端（独立二进制形态）
```

## 与 Go 的关系

Go 侧**在 P0 验收通过前不下线**，它唯一的行为参考是那 7,177 行测试。
Rust 侧的验收标准就是「Go 侧对应测试的行为」，所以**测试要逐条移植，不能跳**。
