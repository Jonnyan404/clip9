# Release 说明模板

发版时**照这份写**，写完贴到 GitHub Release 的正文里。

⚠️★ **这份文件不会自动生效**。GitHub 里能「自动套用」的那个东西叫 `.github/release.yml`
（它的作用是给**自动生成**的 notes 分类）——而 `release.yml` 刻意**没传**
`generate_release_notes`，就是为了不让自动生成的内容盖掉你写的。所以：**这是给人照着抄的**。

⚠️★ 正文用**中文**（拿到包的人看的是这里）；**提交信息仍然一律英文**
（`tools/check-commit-msg.mjs`）。「注释与文档中文、提交英文」是有意的分工，别混。

## 一、发版流程

1. **定版本号**：`v<major>.<minor>.<patch>`，预发布在后面加后缀（`-beta1` / `-rc1`）。

   ⚠️★ 它**只出现在 tag 里**。仓库里没有版本号文件（`rust/Cargo.toml` 那份只在
   「手动触发、没填 tag」时兜底，见 `tools/release-version.mjs`）——所以发版时
   **没有任何文件需要改版本号**。

2. **写这一版的说明**：照下面的骨架写中文变动。先写在草稿里就行，不用急着贴。

3. **commit 一条空的版本记录**：往 `CHANGELOG.md` 顶上加一条只有**版本号与日期**的记录
   （变动留空），提交信息形如 `docs(changelog): v0.1.0-beta4`，push。

   ⚠️★ 为什么先空着也要提交：**tag 指向的那个提交必须能在 `CHANGELOG.md` 里查到自己** ——
   否则 checkout 到某个 tag 上，谁也说不清「这一版是什么」。变动在第 6 步补，
   但「哪一版落在哪一天」这个事实不能等到最后才想起来。

4. **打 tag 并推**：

   ```sh
   git tag v0.1.0-beta4
   git push origin v0.1.0-beta4
   ```

   ⚠️ 触发发布的是**`release: published`**（建好 Release 并点发布那一刻），**不是**
   `push: tags` —— 只推 tag 什么也不会发生。

5. **建 Release**（GitHub 的 New release → 选中刚推的 tag）：

   - 正文贴第 2 步写好的中文说明；
   - ⚠️★ 预发布（`-beta*` / `-rc*`）**必须勾** `Set as a pre-release`：`release.yml`
     用它决定容器镜像**只推 tag、不推 `latest`**，也没法事后再补（`info` job 是按
     release 对象问出来的）；
   - ⚠️ **不要**点「Generate release notes」；
   - 点发布 → `release.yml` 开跑，产物自动上传（`overwrite_files: true`，重跑不会
     卡在「资产已存在」）。

6. **回填 `CHANGELOG.md`**：把第 3 步那条空记录补成中文变动（与 Release 正文**同一份**），
   commit。

7. （按需）OpenWrt 与 Android 各有自己的入口：`openwrt.yml` / `android.yml` 都带
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
| 服务端（VPS / NAS / 树莓派） | `clip9-cli-<平台>-<架构>.tar.gz`（Windows 上是 `.zip`） |
| 桌面客户端 | `clip9-desktop-<平台>-<架构>` 打头的那个（`.dmg` / `.msi` / `.exe` / `.AppImage` / `.deb`） |
| Android 手机 | `clip9-android-v<版本>.apk`（一个包装齐三个架构；想要小包可以下 `-<abi>` 那三个之一） |
| OpenWrt 路由器 | `clip9-server-openwrt-*`（服务端）与 `clip9-luci-openwrt-*`（界面），`.ipk` 或 `.apk` 按系统挑 |

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
