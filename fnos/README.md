# 飞牛 fnOS 应用包（`.fpk`）

把 clip9 装进飞牛 NAS 的「应用中心」，点桌面图标就用 —— 不需要开 Docker、不需要记命令行。

产物是两个包（**一个包只能声明一个架构**）：

| 文件 | 给谁 |
|---|---|
| `clip9-fnos-v<版本>-x86.fpk` | x86_64 的飞牛（绝大多数机器） |
| `clip9-fnos-v<版本>-arm.fpk` | ARM 的飞牛（2026-02 起的公测版，rk3588 / 鲲鹏 / 飞腾） |

## 装

应用中心 → 右上角 **手动安装** → 选 `.fpk`。

装完以后：

- 桌面上多一个 **clip9** 图标，点开就是界面（`http://<NAS>:9501`）；
- 「文件管理」里多一个叫 **clip9** 的共享文件夹，那就是它的数据目录。

> 也可以提交到第三方应用商店（[`conversun/fnos-apps`](https://github.com/conversun/fnos-apps)）走一键安装；
> 官方应用中心上架要在 [developer.fnnas.com](https://developer.fnnas.com) 注册开发者并过审，那是另一件事。

## 数据在哪

```
<应用数据目录>/
├── config.json     首次启动时由服务端自己写一份（照着改，改完重启应用）
├── clip9.redb      历史（文本 / 元数据）
└── uploads/        文件本体
```

因为它在共享文件夹里，飞牛自带的**备份任务能带走它**，用 SMB 也能直接翻上传的文件。

⚠️ **卸载前先备份**：卸载会不会连数据目录一起删，取决于平台那一步的行为，这里不替它保证。

## 配置

`config.json` 里能改的东西与 [主 README](../README.md) 的「配置字段一览」 一致
（密码、房间密码、历史上限、文本/文件上限、文件过期、跨源白名单…）。改完在应用中心里**重启**应用。

⚠️★ **`server.port` 那一格对 fpk 不生效**。服务是用 `-port` 起的（`cmd/service-setup`），
命令行覆盖配置文件 —— 这么写是为了让端口**只有一处权威**：改 `config.json` 里的端口不会改
`clip9.sc` / `ui/config` 里那份声明，而桌面图标是按后者拼地址的。要换端口请在**应用中心**改。

## HTTPS / 装成 PWA

包本身只提供 `http://<NAS>:9501`。浏览器只在**安全上下文**里注册 Service Worker，
所以「加到主屏幕」这种用法需要一层 HTTPS：反代 + 真证书（推荐），或者反代 + 自签证书。

两条注意事项（与 [主 README](../README.md) 的「NAS」那节 同一份）：

- 反代**必须放行 `/push` 的 `Upgrade`** —— 实时推送走的就是 WebSocket；
- 挂在子路径上用 `PREFIX=/clip9`（`config.json` 里的 `server.prefix`），**不要**让反代去改写路径。

## 权限

包声明了 `run-as: package`（`config/privilege`），服务以 `clip9` 用户跑，数据目录里的文件也归它。
这是刻意的 —— 以 root 跑的话共享文件夹里全是 `root:root`，SMB 用普通账号删不掉上传的文件。

## 自己打一个

```bash
# 版本取 rust/Cargo.toml；也可以 --version v0.2.0
./fnos/scripts/package-fnos.sh

# 已经有 Release 的 tar.gz（CI 就是这么用的，不重复下载）
./fnos/scripts/package-fnos.sh --version v0.2.0 --in <目录> --out dist

# 只验一个已经打好的包
./fnos/scripts/package-fnos.sh --verify dist/clip9-fnos-v0.2.0-x86.fpk
```

脚本**不编译**任何东西：用的是 Release 里那两个 musl 静态二进制（与 Dockerfile 同一个道理 ——
发出去的必须是**发出去的那一份**）。打完每个包会当场自检：结构、`manifest` 的 checksum、
二进制架构。这三样坏掉都**不会让安装报错**，只会装上去点不开。

包内的约定（端口四处一致、桌面入口键、图标尺寸…）由 `node tools/fnos-package-smoke.mjs` 守着。

## 已知限制

- **改端口只能走应用中心**（见上面「配置」）。
- **没有自动更新**：应用中心不会去查 GitHub Release，升级就是下载新包再装一次（数据目录保留）。
- 只覆盖 `x86` 与 `arm`（= arm64）。fnOS 没有 armv7 版本，所以没有第三个包。
