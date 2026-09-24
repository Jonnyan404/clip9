# clip9 —— Rust 重写版（过渡期工作区）

这个目录是 `cloud-clipboard-go` 的 **Rust 重写实现**，按
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) 的 §8 分阶段清单推进。
过渡期它住在这里，**对齐完成、用 Rust 发过一次版之后**再拆成独立仓库。

## 动手之前读这两份

- **[`docs/HANDOVER.md`](./docs/HANDOVER.md)** —— 现在到哪了、怎么跑、怎么验、下一步。
  **每轮改动后要更新它。**
- **[`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)** —— 工程约定：选型原则、零警告门禁、
  分层边界、反模式清单。它记的不是泛泛的「最佳实践」，而是这个项目里已经踩过的具体坑。

一句话版本：**选型之前先验证（bincode 是墓碑版本的教训）；改契约之前先找证据
（fixture + 双跑比对，别读代码觉得对）；写完跑门禁（`fmt` / `clippy -D warnings` / `test`）。**

全部文档的索引在 [`docs/README.md`](./docs/README.md)。

## ⚠️ 这个目录完全本地，不要推到 GitHub

- 父仓库 `.gitignore` 里有一条 `rust/` —— **别删**。删了之后 git 会把它当**嵌套仓库**，
  `git add -A` 有可能把整棵树提交到 `cloud-clipboard-go`（那正是要避免的事）。
- 它自己有一个**没有 remote** 的本地 git 仓库（和隔壁 `clip-sync/` 一个路子）。
  `git remote -v` 应该是空的 —— **推之前先确认这一条**。
- 开发完毕、要拆出去时：直接把这个目录推到一个**新** GitHub 仓库即可。
  历史就是这里的本地历史，**不从 `cloud-clipboard-go` 里 `filter-repo` 抽** ——
  原因见 `docs/ARCHITECTURE.md` §10.5（「不入库」和「历史在主仓库里」是矛盾的，选了前者）。
- ⚠️ 拆出去时 `docs/api*.md`、`cases/`、`web-vue3/` 要**一起带过去**（代码和测试引用它们）。

## 目录

```
rust/
├── Cargo.toml               # workspace
├── docs/                    # ★ 文档都在这里（索引见 docs/README.md）
│   ├── ARCHITECTURE.md      #   设计权威：判断、取舍、分阶段清单
│   ├── CONTRIBUTING.md      #   工程约定
│   ├── HANDOVER.md          #   现状与交接（活文档）
│   └── specs/               #   行为规格（从 Go 实现提炼，Rust 要逐条复现）
├── crates/
│   ├── protocol/            # ★ 契约层：请求/响应/WS 事件的 serde 类型。零 IO
│   ├── core/                # 领域逻辑：房间鉴权、会话令牌、分享 token、模板引擎、cron
│   ├── actions/             # ★ 单一动作库：纯函数、无 IO → 原生 + wasm32
│   ├── store/               # ★ redb 封装：只有这里知道存储长什么样
│   ├── server/              # axum HTTP+WS；lib（可内嵌）+ bin（可独立跑）
│   └── client/              # 剪贴板监控 + 上行 + 下行
```

依赖单向：`protocol ← core ← store ← server ← { bin, client }`，`actions ← core/server/WASM`。
每个 crate **不许做什么**见 `docs/CONTRIBUTING.md` §4。

## 用例数据在父仓库

| 位置 | 内容 | 谁读 |
|---|---|---|
| `../cases/protocol/*.json` | 从 Go 导出的 JSON fixture，钉住字段名与形状 | Rust 测试（反序列化断言） |
| `../cases/actions.json` | 动作行为用例（还没建） | **Go 与 Rust 都读** = 双跑验证 |

⚠️ 这两个文件**属于契约**，所以放在父仓库入库；`rust/` 本身不入库。

## 工具链

rustup 管理（2026-09-25 装，见 `~/.zprofile`）。
⚠️ 本机同时有一份 Homebrew 的 rust，**只有 `x86_64-apple-darwin` 一个 target**；
`~/.zprofile` 里 `. "$HOME/.cargo/env"` 必须排在 `brew shellenv` 之后，`cargo` 才是 rustup 那份。
`rustup target list --installed` 里应该能看到 wasm32 与几个 musl / android 目标。

⚠️ **crates.io 直连在这台机器上拉不动**（大面积超时）→ `.cargo/config.toml` 里配了 USTC 镜像。
只影响这个目录，不动全局配置。

```bash
cargo build --workspace          # 原生（macOS）开发
cargo test  --workspace
cargo run -p clip9-server -- --port 19501
```

## 与 Go 的关系

Go 侧**在 P0 验收通过前不下线**，它唯一的行为参考是那 7,177 行测试。
Rust 侧的验收标准就是「Go 侧对应测试的行为」，所以**测试要逐条移植，不能跳**。
