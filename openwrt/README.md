# clip9 for OpenWrt

把 clip9 装成 OpenWrt 上的一个服务（由 procd 托管，开机自启），另有一个可选的 LuCI 网页界面。

装完之后你在浏览器里就有一个剪贴板：同一个局域网里任何设备访问
`http://路由器IP:9501` 就能收发。

## 一、挑对包再装

先看你的 OpenWrt 版本，决定用哪种包格式：

| OpenWrt 版本 | 包格式 | 装法 |
|---|---|---|
| **25.12 及以上** | `.apk` | `apk add --allow-untrusted /tmp/<包名>.apk` |
| **24.10 及以下** | `.ipk` | `opkg install /tmp/<包名>.ipk` |

要装**两个包**：服务端 + LuCI 界面（界面是单独的包，不装就没有网页可点）：

```
clip9-openwrt-v<版本>-<架构>.<ipk|apk>        ← 服务端
clip9-luci-openwrt-v<版本>-all.ipk            ← 界面（ipk 的那份）
clip9-luci-openwrt-apk-v<版本>-noarch.apk     ← 界面（apk 的那份）
```

先把包传到路由器，再在路由器上装：

```sh
scp clip9-openwrt-v0.1.1-x86_64.ipk       root@192.168.1.1:/tmp/
scp clip9-luci-openwrt-v0.1.1-all.ipk     root@192.168.1.1:/tmp/
ssh root@192.168.1.1
opkg install /tmp/clip9-openwrt-v0.1.1-x86_64.ipk /tmp/clip9-luci-openwrt-v0.1.1-all.ipk
```

> ⚠️ 文件名里**不带 `server`**，但装上去之后那个程序叫 `clip9-server`
> （`/usr/bin/clip9-server`，服务脚本 `/etc/init.d/clip9`）。

## 二、`<架构>` 填什么

**名字要和你设备的架构对得上**，否则会报
`Packages for clip9 found, but incompatible with the architectures configured`。
先查你自己的：

```sh
opkg print-architecture      # 24.10 及以下
cat /etc/apk/arch            # 25.12 及以上
```

然后照下表挑 —— **产物名用的就是设备架构名**：

| 产物里的架构名 | 适用设备 |
|---|---|
| `x86_64` | 64 位 x86 软路由 |
| **32 位 ARM**：`.ipk` 是 `arm_cortex-a5` / `-a7` / `-a8` / `-a9` / `-a15_neon-vfpv4`；<br>`.apk` 是 `arm_cortex-a9` / `-a9_neon` / `-a15_neon-vfpv4` | 各种 32 位 ARM 路由。⚠️ 这几个名字用的是**同一份二进制**（同一套 EABI 硬浮点 ABI），所以名字按你的包格式对就行 |
| `aarch64_generic` / `aarch64_cortex-a53` / `-a72` / `-a76` | 64 位 ARM 路由。同样是**一份二进制编 4 个包** |

Release 上服务端包一共有 **10 个 `.ipk`** 与 **8 个 `.apk`**。
⚠️ **没有 mips / mipsel**（Rust 对那两个架构只到 Tier 3，工具链装不上）。

> 拿不准就看一眼你的 `opkg print-architecture` 输出，里面那个不是 `all` / `noarch` 的行
> 就是答案。

## 三、装完怎么用

数据与配置都在 `/etc/clip9/`：

| | 位置 | 说明 |
|---|---|---|
| 服务开关 / 监听地址 / 端口 / 访问密码 | `/etc/config/clip9`（UCI） | 也可以用 LuCI 界面改 |
| 历史与上传的文件 | `/etc/clip9/data/` | redb 库 + `uploads/` |
| 高级项（房间密码、过期时间…） | `/etc/clip9/config.json` | **不用手写**，不存在时服务端自己写一份默认的 |

```sh
/etc/init.d/clip9 restart       # 改完配置
/etc/init.d/clip9 status        # 看它在不在跑
```

几个房间各用一个密码：

```json
{
  "server": {
    "auth": true,
    "roomAuth": { "private": "", "finance": "finance-pass" }
  }
}
```

> `""` 表示这个房间**沿用全局**那个 `auth`；要一个**不要密码**的房间，写
> `{"open": true}`（LuCI 的高级设置里可以直接勾）。

## 四、LuCI 网页界面

装好那两个包之后，进 LuCI 的**「服务」→「Clip9」**：

- **总览** —— 运行状态、监听参数、数据盘占用、检查上游版本、直接启停
- **基本设置** —— 开关 / 监听地址 / 端口 / 访问密码 / 数据目录 / 配置文件路径
- **高级设置** —— 房间密码、文本与文件上限、专家模式直接编辑 `config.json`
- **日志** —— 实时日志（5 秒自动刷新）

如果是装完界面包后菜单没出现，重启一下 LuCI 的 web 服务：`/etc/init.d/uhttpd restart`。

## 五、常见问题

**历史重启之后还在吗？** 在。数据放在 `/etc/clip9/data`，而 `/etc` 在 overlay 上、重启不丢。
（⚠️ 这就是它**不在** `/var/lib` 的原因：OpenWrt 的 `/var` 通常是指向 `/tmp` 的软链，
放那儿每次重启历史就没了。）

**怎么卸载？** `opkg remove clip9 luci-app-clip9`（apk 那边是 `apk del clip9 luci-app-clip9`）。
⚠️ 卸载只会停掉服务、摘掉那两个包的文件 —— `prerm` 里没有删数据的动作，所以
`/etc/clip9/`（历史与配置）**会留着**，要清干净得自己删那个目录。

**界面为什么只有中文？** 这条手工打包链路不做翻译编译（`.lmo`），所以 `.po` 里的英文没生效。

**路由器的性能和这个有关吗？** 它就是一个静态二进制 + 一个 redb 文件，服务端本身不占 CPU；
真正的开销在存储（历史条数与上传文件），可以在「高级设置」里限制。

---

要**自己打包 / 改这个目录**（`cross`、每个 target 单独目录、跨架构的坑、验过什么）：
见 [`DEVELOPING.md`](./DEVELOPING.md)。
