# Release 说明模板

发版前**照这份写这一版的说明**；写进 `CHANGELOG.md` 就算完事 —— **Release 正文会自动从那里
抽出来**（`release.yml` 的 `release-notes` job 调 `tools/release-notes.mjs`），不用再贴一次。

⚠️★ 这个「自动」只到**贴**为止：**正文内容仍然要人写**（骨架在第二节）。GitHub 里那个能
自动生成说明的开关叫 `generate_release_notes`，`release.yml` 刻意**没传**它 —— 所以别指望
它，也别在网页上点「Generate release notes」（那份自动生成的分类内容会盖掉手写的）。

⚠️★ 正文用**中文**（拿到包的人看的是这里）；**提交信息仍然一律英文**
（`tools/check-commit-msg.mjs`）。「注释与文档中文、提交英文」是有意的分工，别混。

## 一、发版流程

1. **定版本号**：`v<major>.<minor>.<patch>`，预发布在后面加后缀（`-beta1` / `-rc1`）。

   ⚠️★ 它**只出现在 tag 里**。仓库里没有版本号文件（`rust/Cargo.toml` 那份只在
   「手动触发、没填 tag」时兜底，见 `tools/release-version.mjs`）——所以发版时
   **没有任何文件需要改版本号**。

2. **写这一版的说明**：照第二节的骨架写中文变动。⚠️ 直接写进 `CHANGELOG.md`（第 3 步），
   不用先打在别处 —— Release 正文就是从那里抽的。

3. **往 `CHANGELOG.md` 顶上写这一版**（版本号 + 日期 + 中文变动）并 commit、push。
   提交信息形如 `docs(changelog): v0.1.0`。

   ⚠️★ **内容要在这里一次写全** —— 这一步是「这一版说明」**唯一**的地方（Release 正文抽它）。
   以前是「先提交一条只有版本号与日期的空记录、发完再回填」，**2026-09-29 起不用了**：
   那个「回填」十有八九会被忘掉（`v0.1.0` 那次就没做），而现在正文是抽出来的 ——
   抽到那条空记录会**直接报错**（`tools/release-notes.mjs` 认「变动留空」/「待发布」这类占位）。

   ⚠️★ 仍然是**先提交、再打 tag**：**tag 指向的那个提交必须能在 `CHANGELOG.md` 里查到自己**
   —— 否则 checkout 到某个 tag 上，谁也说不清「这一版是什么」。

4. **打 tag 并推**：

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   ⚠️ 触发发布的是**`release: published`**（建好 Release 并点发布那一刻），**不是**
   `push: tags` —— 只推 tag 什么也不会发生。

5. **建 Release**（GitHub 的 New release → 选中刚推的 tag）：

   - **正文留空** —— 会自动从 `CHANGELOG.md` 抽（发布后刷一下页面看）。
     ⚠️ 页面刚出来那几秒可能显示一段英文：那是 GitHub 在正文为空时拿 tag 指向的**提交信息**
     顶上去的（提交信息是英文的）。`release-notes` job 跑完就换成中文了；
   - ⚠️★ 预发布（`-beta*` / `-rc*`）**必须勾** `Set as a pre-release`：`release.yml`
     用它决定容器镜像**只推 tag、不推 `latest`**，也没法事后再补（`info` job 是按
     release 对象问出来的）；
   - ⚠️ **不要**点「Generate release notes」；
   - 点发布 → `release.yml` 开跑：产物自动上传（`overwrite_files: true`，重跑不会
     卡在「资产已存在」），`release-notes` job 把正文补上。

   ⚠️ 补正文那一步红了（比如忘了写第 3 步的说明）**不会**回滚已经传上去的资产 ——
   单独重跑那个 job 就行，不必重发一遍。

6. （按需）OpenWrt 与 Android 各有自己的入口：`openwrt.yml` / `android.yml` 都带
   `workflow_dispatch`，填上 tag 就能**覆盖上传**那两个包 —— 它们**不在**主发布链路里，
   所以主发布不会因为它们缺个 secret 而卡住。

## 二、发布说明骨架（复制下面这段去写）

```markdown
### 这一版有什么

（两三句话：这一版最值得说的一件事是什么。别只复述下面的列表。）

### 新增

- 

### 修复

- 

### 变动（要手动做的）

- ⚠️ （配置项改名 / 老数据要迁移 / 要重装客户端……）

（没有就整节删掉，别留一个空标题。）

### 下载哪个

（这一段**不是**资产列表的复述，而是「我该下哪一个」。照下面的表挑相关的行留下。）
```

### 「下载哪个」的对照表

| 我要装在哪 | 下哪个 |
| --- | --- |
| 服务端（VPS / NAS / 树莓派） | `clip9-cli-v<版本>-<平台>-<架构>.tar.gz`（Windows 上是 `.zip`） |
| 桌面客户端 | `clip9-desktop-v<版本>-<平台>-<架构>` 打头的那个（`.dmg` / `.msi` / `.exe` / `.AppImage` / `.deb`） |
| Android 手机 | `clip9-android-v<版本>.apk`（一个包装齐三个架构；想要小包可以下 `-<abi>` 那三个之一） |
| OpenWrt 路由器 | `clip9-openwrt-v<版本>-*`（服务端）与 `clip9-luci-openwrt-*`（界面），`.ipk` 或 `.apk` 按系统挑 |

⚠️★ **产物名里一律带版本号**，而且 `v<版本>` **紧跟在 `clip9-<东西>` 之后** ——
   Jonny 2026-09-29：「要么都带版本号要么都不」。加新产物时照这条排，别把
   `linux-x86_64` 那种标签插到版本号前面去（`release.yml` 的文件头写着这条规则）。

`<平台>-<架构>` 是实的：CLI 有 `linux-{x86_64,aarch64,armv7}`、
`macos-{x86_64,aarch64}`、`windows-{x86_64,aarch64}`；桌面端少一些（`linux` 只有 `x86_64`、
`windows` 只有 `x86_64`）。⚠️ 拿不准就看 Release 页面下面的资产列表 —— 那是**唯一**的
事实来源，这份表只是帮你少翻两屏。

## 三、写说明时的几条

- **先说人话**：「窗口大小会记住了」比「persist window geometry in window.json」有用得多。
  这一版改了什么对用户意味着什么，才是正文该有的东西。
- ⚠️ **破坏性变动必须写在最显眼的地方**（配置项改名、老数据不迁移、要重装……）。
  这类事只说一遍就是没说。
- **不用**列全部资产、不用贴构建号、不用写「内部重构」之类用户看不见的东西 ——
  想看细节的人会去看 commit。
- 预发布也别省这段：`-beta` 是「可能还有问题」，把**这一版专门想让人试什么**写清楚。
