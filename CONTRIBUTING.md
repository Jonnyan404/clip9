# clip9 工程约定

> **这个文件是给下个接手的人看的。** 它不是「最佳实践清单」那种泛泛的东西 ——
> 每一条都对应这个项目里**已经踩过或差点踩到**的具体坑，并且尽量给出可核对的证据。
>
> 有冲突时：本文件 > 个人习惯。改本文件请单独一个提交，并在提交信息里说明为什么。

---

## 1. 选型：先查「它还活着吗」，再比参数

**教训（2026-09-25）**：`bincode` 写进 `Cargo.toml` 之后整个 workspace 编不过，报错只有一行
`https://xkcd.com/2347/`。原因是它的**最后一个版本 3.0.0 是墓碑版本** —— `lib.rs` 全文只有一句
`compile_error!`，README 标题就是「Bincode is now unmaintained」（作者因被人肉骚扰而终止开发）。
crates.io 没有办法把包标记成「已归档」，所以它就一直挂在那儿，谁搜到谁中招。

所以引入任何依赖之前：

1. **查最新版本是哪天发的**（`crates.io/api/v1/crates/<name>` 的 `updated_at`），以及上游 README
   有没有停维护声明。两三年没动 + 无声明 = 至少要知道自己在赌什么。
2. **实际编译一遍**，别只读文档。bincode 这个坑读文档是看不出来的，编译一次就现形。
3. **把否决理由就地写下来**，写在用到它的那个模块的注释里 —— 不是另开一份决策日志。
   理由见 §5。

参考写法：`crates/store/src/lib.rs` 的模块注释里有一张「考虑过的替代方案，以及为什么否掉」的表。
那张表比任何「我们用了 JSON」的说明都有价值，因为它回答了下一个人的第一个问题：**为什么不换一个？**

## 2. 门禁：提交前必跑，零警告是硬要求

```bash
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test  --workspace
```

`-D warnings` 不是「尽量」—— 警告会堆积，堆积之后就没人看了。
今天能过，是因为每次改完都顺手清了；一旦破例一次，这条约定就废了。

## 3. 契约纪律：不许靠「读代码觉得对」

`crates/protocol` 是**契约层**，它对齐的是 Go 那边的线上格式（`docs/api.md` 是权威）。

- **字段名与 Go 的 json tag 逐字一致**（`senderIP` / `senderClientID` / `boardColumn`…）。
  不是「差不多」，是逐字 —— 存量客户端、Apple/Android 捷径、Cloudflare Worker、已发布的 PWA
  都按那份契约说话。
- **改了字段名或 omitempty，先跑 Go 侧的 fixture 生成**：
  ```bash
  cd cloud-clip && UPDATE_FIXTURES=1 go test ./lib -run TestProtocolFixtures
  ```
  然后 `cargo test -p clip9-protocol` 必须绿。它红了不是「测试坏了」，是**一次契约变更**。
- **改接口之后要起真实实例和 Go 并排比对**，不要只读代码。
  2026-09-25 第一次比对就抓到 `/server` 的形状是编的（我按扁平结构写，实际是嵌套的，
  而且 `automation` 里带着 34 个动作的完整声明）。
- ⚠️ `cases/` 是**契约数据，不许手工编辑** —— 它是导出产物。

## 4. 分层边界：每个 crate 有它「不许做」的事

| crate | 不许做的事 | 为什么 |
|---|---|---|
| `protocol` | 任何 IO、任何运行时依赖 | 它要能编到 `wasm32` 给前端用 |
| `core` | 依赖 `axum` / `http` | 鉴权、cron 这些要能被客户端复用、也要好测 |
| `store` | 被别的 crate 绕过 | 「只有这里知道存储长什么样」是换引擎时改动不外溢的全部保证 |
| `actions` | `std::fs`、`web_sys`、任何 IO | 同一份代码要编成原生 + WASM |
| `server` | 自己实现鉴权/会话逻辑 | 那是 `core` 的职责，写两遍必然漂 |

依赖方向是**单向**的：`protocol ← core ← store ← server ← {bin, client}`。

## 5. 注释：写「为什么」，并且写清**否决了什么**

「为什么」比「是什么」值钱，「否决了什么」比「为什么」还值钱 —— 因为它省掉的是下一个人
**重新评估一遍**的时间。

```rust
// ✗ 没用的注释
// 把时间戳倒序编码

// ✓ 有用的注释
// ⚠️ 直接 `u64::MAX - ts as u64` 是错的：负数会被当成极大的正数排到最前。
// 这个项目里时间戳现实中都是正的，但「现实中不会」不该是编码的前提。
```

注释用中文。这个仓库一直是中文注释，改语言会让 `git blame` 出来的历史没法读。

## 6. 反模式：这些是明确不要做的

- **不要 `unwrap_or(某个默认值)` 掩盖溢出或失败。**
  实例：`i32::try_from(next_id).unwrap_or(i32::MAX)` —— 跑到 21 亿条之后每条消息都会拿到同一个
  id，键互相覆盖、**静默丢数据**，而且测试永远碰不到。该硬失败就硬失败。
- **不要引入「靠人肉同步的第二份定义」。**
  这个项目已经被这类 bug 咬过多次（前端 `actions.js` 与服务端 `render_actions.go` 靠 id 契约测试
  勉强对齐；`replace-modes.json` 是为了绕开两份实现而发明的第三样东西）。
  要引入副本，先想清楚**怎么让漏掉字段这件事变成编译错误或测试失败**。
- **不要静默丢数据。** 超限要么丢最旧的**并留下日志**，要么拒绝写入。两条路都行，
  「悄悄少了几条」不行。
- **不要在写入路径上做全表扫。** 裁剪要拆成「写入时按 key 局部裁（快）」+「低频后台全库整理（慢）」。
- **不要加「看起来以后有用」的抽象。** feature flag 能解决 90% 的可插拔需求，
  运行期插件系统是另一件事（见 `clip-sync/ARCHITECTURE.md` §5.6 的 YAGNI 论证）。
- **不要用非自描述格式存带 `#[serde(flatten)]` 或 `skip_serializing_if` 的类型。**
  它会**静默错位**，不报错。理由与实测见 `crates/store/src/lib.rs` 的模块注释。

## 7. 测试：断言要钉住顺序、边界、副作用

「跑通了」不算验证。每条测试的注释要说清**它防的是什么错**，尤其是那些
「不报错、只是结果不对」的 —— 这类错才是这个项目的主要风险。

- 顺序类：同一秒内的多条按 id 倒序（`same_timestamp_falls_back_to_id_order`）
- 边界类：`work` 和 `works` 不能互相串（`rooms_are_strictly_isolated`）
- 副作用类：淘汰条目之后 `by_id` 也必须清掉（`per_room_limit_evicts_the_oldest_on_write`）
- 契约类：Go 导出的 fixture 往返之后必须逐字节等价（`crates/protocol/tests/go_fixtures.rs`）

⚠️ 反向测试也是测试：`flattened_types_cannot_use_non_self_describing_formats` 断言的是
「这件事**做不到**」。它存在的意义是：哪天做到了，说明上游变了，该回来重读决策。

## 8. 提交

- **英文** conventional commits（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `build:`）。
- 一次提交一件事。构建产物单独一个 `build(...)` 提交。
- 提交信息写清**为什么**，以及**否决了什么**。`fix(tools): kill headless Chrome on SIGINT`
  比 `fix: cleanup` 有用得多。

## 9. 关于这个目录

`rust/` 是**过渡期的工作区**，完全本地、不入父仓库、有自己的本地 git 仓库（无 remote）。
细节和「拆出去」的时机见 `README.md`。
